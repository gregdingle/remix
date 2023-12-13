import type * as Vite from "vite";
import path from "node:path";
import fse from "fs-extra";
import colors from "picocolors";

import type {
  ResolvedRemixVitePluginConfig,
  ServerBuildConfig,
} from "./plugin";
import type { ConfigRoute, RouteManifest } from "../config/routes";
import invariant from "../invariant";

async function extractRemixPluginConfig({
  configFile,
  mode,
  root,
}: {
  configFile?: string;
  mode?: string;
  root: string;
}) {
  let vite = await import("vite");

  // Leverage the Vite config as a way to configure the entire multi-step build
  // process so we don't need to have a separate Remix config
  let viteConfig = await vite.resolveConfig(
    { mode, configFile, root },
    "build"
  );

  let pluginConfig = viteConfig[
    "__remixPluginResolvedConfig" as keyof typeof viteConfig
  ] as ResolvedRemixVitePluginConfig | undefined;
  if (!pluginConfig) {
    console.error(colors.red("Remix Vite plugin not found in Vite config"));
    process.exit(1);
  }

  return { pluginConfig, viteConfig };
}

function getLeafRoutes(routes: RouteManifest): ConfigRoute[] {
  let parentIds = new Set<string>();
  for (let id in routes) {
    let { parentId } = routes[id];
    if (typeof parentId === "string") {
      parentIds.add(parentId);
    }
  }

  let leafRoutes = [];
  for (let id in routes) {
    if (!parentIds.has(id)) {
      leafRoutes.push(routes[id]);
    }
  }

  return leafRoutes;
}

function getRouteBranch(routes: RouteManifest, routeId: string) {
  let branch: ConfigRoute[] = [];
  let currentRouteId: string | undefined = routeId;

  while (currentRouteId) {
    invariant(routes[currentRouteId], `Missing route for ${currentRouteId}`);
    branch.push(routes[currentRouteId]);
    currentRouteId = routes[currentRouteId].parentId;
  }

  return branch.reverse();
}

type ServerBundlesManifest = {
  routes: RouteManifest;
  bundles: {
    [routeId: string]: {
      path: string;
      name: string;
    };
  };
};

async function getServerBundles({
  routes,
  serverBuildDirectory,
  serverBuildFile,
  serverBundles: getServerBundles,
}: ResolvedRemixVitePluginConfig): Promise<{
  serverBundles: ServerBuildConfig[];
  bundlesManifest?: ServerBundlesManifest;
}> {
  if (!getServerBundles) {
    return { serverBundles: [{ routes, serverBuildDirectory }] };
  }

  let serverBundles = new Map<string, ServerBuildConfig>();
  let bundlesManifest: ServerBundlesManifest = { routes, bundles: {} };

  await Promise.all(
    getLeafRoutes(routes).map(async (route) => {
      let branch = getRouteBranch(routes, route.id);

      let bundleName = await getServerBundles({ route, branch });
      let serverBundleDirectory = path.join(serverBuildDirectory, bundleName);

      bundlesManifest.bundles[route.id] = {
        name: bundleName,
        path: path.join(serverBundleDirectory, serverBuildFile),
      };

      let serverBuildConfig = serverBundles.get(serverBundleDirectory);
      if (!serverBuildConfig) {
        serverBuildConfig = {
          routes: {},
          serverBuildDirectory: serverBundleDirectory,
        };
        serverBundles.set(serverBundleDirectory, serverBuildConfig);
      }
      for (let route of branch) {
        serverBuildConfig.routes[route.id] = route;
      }
    })
  );

  return {
    serverBundles: Array.from(serverBundles.values()),
    bundlesManifest,
  };
}

async function cleanServerBuildDirectory(
  viteConfig: Vite.ResolvedConfig,
  { rootDirectory, serverBuildDirectory }: ResolvedRemixVitePluginConfig
) {
  let isWithinRoot = () => {
    let relativePath = path.relative(rootDirectory, serverBuildDirectory);
    return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
  };

  if (viteConfig.build.emptyOutDir ?? isWithinRoot()) {
    await fse.remove(serverBuildDirectory);
  }
}

export interface ViteBuildOptions {
  assetsInlineLimit?: number;
  clearScreen?: boolean;
  config?: string;
  emptyOutDir?: boolean;
  force?: boolean;
  logLevel?: Vite.LogLevel;
  minify?: Vite.BuildOptions["minify"];
  mode?: string;
}

export async function build(
  root: string,
  {
    assetsInlineLimit,
    clearScreen,
    config: configFile,
    emptyOutDir,
    force,
    logLevel,
    minify,
    mode,
  }: ViteBuildOptions
) {
  let { pluginConfig, viteConfig } = await extractRemixPluginConfig({
    configFile,
    mode,
    root,
  });

  let vite = await import("vite");

  async function viteBuild(serverBuildConfig?: ServerBuildConfig) {
    let ssr = Boolean(serverBuildConfig);
    await vite.build({
      root,
      mode,
      configFile,
      build: { assetsInlineLimit, emptyOutDir, minify, ssr },
      optimizeDeps: { force },
      clearScreen,
      logLevel,
      ...(serverBuildConfig
        ? { __remixServerBuildConfig: serverBuildConfig }
        : {}),
    });
  }

  // Since we're potentially running multiple Vite server builds with different
  // output directories, we need to clean the root server build directory
  // ourselves rather than relying on Vite to do it, otherwise you can end up
  // with stale server bundle directories in your build output
  await cleanServerBuildDirectory(viteConfig, pluginConfig);

  // Run the Vite client build first
  await viteBuild();

  // Then run Vite SSR builds in parallel
  let { serverBundles, bundlesManifest } = await getServerBundles(pluginConfig);

  await Promise.all(serverBundles.map(viteBuild));

  if (bundlesManifest) {
    await fse.writeFile(
      path.join(pluginConfig.serverBuildDirectory, "bundles.json"),
      JSON.stringify(bundlesManifest, null, 2),
      "utf-8"
    );
  }
}
