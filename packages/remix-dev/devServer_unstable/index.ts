import * as path from "node:path";
import * as stream from "node:stream";
import fs from "fs-extra";
import prettyMs from "pretty-ms";
import execa from "execa";
import express from "express";

import * as Channel from "../channel";
import { type Manifest } from "../manifest";
import * as Compiler from "../compiler";
import { readConfig, type RemixConfig } from "../config";
import { loadEnv } from "./env";
import * as Socket from "./socket";
import * as HMR from "./hmr";
import { warnOnce } from "../warnOnce";
import { detectPackageManager } from "../cli/detectPackageManager";

type Origin = {
  scheme: string;
  host: string;
  port: number;
};

let stringifyOrigin = (o: Origin) => `${o.scheme}://${o.host}:${o.port}`;

let patchPublicPath = (
  config: RemixConfig,
  devHttpOrigin: Origin
): RemixConfig => {
  // set public path to point to dev server
  // so that browser asks the dev server for assets
  return {
    ...config,
    // dev server has its own origin, to `/build/` path will not cause conflicts with app server routes
    publicPath: stringifyOrigin(devHttpOrigin) + "/build/",
  };
};

let detectBin = async (): Promise<string> => {
  let pkgManager = detectPackageManager() ?? "npm";
  if (pkgManager === "npm") {
    // npm v9 removed the `bin` command, so have to use `prefix`
    let { stdout } = await execa(pkgManager, ["prefix"]);
    return stdout.trim() + "/node_modules/.bin";
  }
  let { stdout } = await execa(pkgManager, ["bin"]);
  return stdout.trim();
};

export let serve = async (
  initialConfig: RemixConfig,
  options: {
    command: string;
    httpScheme: string;
    httpHost: string;
    httpPort: number;
    publicDirectory: string;
    websocketPort: number;
    restart: boolean;
  }
) => {
  await loadEnv(initialConfig.rootDirectory);
  let websocket = Socket.serve({ port: options.websocketPort });
  let httpOrigin: Origin = {
    scheme: options.httpScheme,
    host: options.httpHost,
    port: options.httpPort,
  };

  let state: {
    appServer?: execa.ExecaChildProcess;
    manifest?: Manifest;
    prevManifest?: Manifest;
    appReady?: Channel.Type<void>;
  } = {};

  let bin = await detectBin();
  let startAppServer = (command: string) => {
    console.log(`> ${command}`);
    let newAppServer = execa.command(command, {
      stdio: "pipe",
      env: {
        NODE_ENV: "development",
        PATH: `${bin}:${process.env.PATH}`,
        REMIX_DEV_HTTP_ORIGIN: stringifyOrigin(httpOrigin),
      },
    });

    if (newAppServer.stdin)
      process.stdin.pipe(newAppServer.stdin, { end: true });
    if (newAppServer.stderr)
      newAppServer.stderr.pipe(process.stderr, { end: false });
    if (newAppServer.stdout) {
      newAppServer.stdout
        .pipe(
          new stream.PassThrough({
            transform(chunk, _, callback) {
              let str: string = chunk.toString();
              let matches =
                str && str.matchAll(/\[REMIX DEV\] ([A-f0-9]+) ready/g);
              if (matches) {
                for (let match of matches) {
                  let buildHash = match[1];
                  if (buildHash === state.manifest?.version) {
                    state.appReady?.ok();
                  }
                }
              }

              callback(null, chunk);
            },
          })
        )
        .pipe(process.stdout, { end: false });
    }

    return newAppServer;
  };

  let dispose = await Compiler.watch(
    {
      config: patchPublicPath(initialConfig, httpOrigin),
      options: {
        mode: "development",
        sourcemap: true,
        onWarning: warnOnce,
        devHttpOrigin: httpOrigin,
        devWebsocketPort: options.websocketPort,
      },
    },
    {
      reloadConfig: async (root) => {
        let config = await readConfig(root);
        return patchPublicPath(config, httpOrigin);
      },
      onBuildStart: (ctx) => {
        state.appReady?.err();
        clean(ctx.config);
        websocket.log(state.prevManifest ? "Rebuilding..." : "Building...");
      },
      onBuildManifest: (manifest: Manifest) => {
        state.manifest = manifest;
      },
      onBuildFinish: async (ctx, durationMs, succeeded) => {
        if (!succeeded) return;

        websocket.log(
          (state.prevManifest ? "Rebuilt" : "Built") +
            ` in ${prettyMs(durationMs)}`
        );
        state.appReady = Channel.create();

        let start = Date.now();
        console.log(`Waiting for app server (${state.manifest?.version})`);
        if (
          options.command &&
          (state.appServer === undefined || options.restart)
        ) {
          await kill(state.appServer);
          state.appServer = startAppServer(options.command);
        }
        let { ok } = await state.appReady.result;
        // result not ok -> new build started before this one finished. do not process outdated manifest
        if (ok) {
          console.log(`App server took ${prettyMs(Date.now() - start)}`);

          if (state.manifest?.hmr && state.prevManifest) {
            let updates = HMR.updates(
              ctx.config,
              state.manifest,
              state.prevManifest
            );
            websocket.hmr(state.manifest, updates);

            let hdr = updates.some((u) => u.revalidate);
            console.log("> HMR" + (hdr ? " + HDR" : ""));
          } else if (state.prevManifest !== undefined) {
            websocket.reload();
            console.log("> Live reload");
          }
        }
        state.prevManifest = state.manifest;
      },
      onFileCreated: (file) =>
        websocket.log(`File created: ${relativePath(file)}`),
      onFileChanged: (file) =>
        websocket.log(`File changed: ${relativePath(file)}`),
      onFileDeleted: (file) =>
        websocket.log(`File deleted: ${relativePath(file)}`),
    }
  );

  let httpServer = express()
    // statically serve built assets
    .use((_, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      next();
    })
    .use(
      "/build",
      express.static(initialConfig.assetsBuildDirectory, {
        immutable: true,
        maxAge: "1y",
      })
    )
    .use(express.static(options.publicDirectory, { maxAge: "1h" }))

    // handle `broadcastDevReady` messages
    .use(express.json())
    .post("/ping", (req, res) => {
      let { buildHash } = req.body;
      if (typeof buildHash !== "string") {
        console.warn(`Unrecognized payload: ${req.body}`);
        res.sendStatus(400);
      }
      if (buildHash === state.manifest?.version) {
        state.appReady?.ok();
      }
      res.sendStatus(200);
    })
    .listen(httpOrigin.port, () => {
      console.log("Remix dev server ready");
    });

  return new Promise(() => {}).finally(async () => {
    await kill(state.appServer);
    websocket.close();
    httpServer.close();
    await dispose();
  });
};

let clean = (config: RemixConfig) => {
  try {
    fs.emptyDirSync(config.relativeAssetsBuildDirectory);
  } catch {}
};

let relativePath = (file: string) => path.relative(process.cwd(), file);

let kill = async (p?: execa.ExecaChildProcess) => {
  if (p === undefined) return;
  let channel = Channel.create<void>();
  p.on("exit", channel.ok);

  // https://github.com/nodejs/node/issues/12378
  if (process.platform === "win32") {
    await execa("taskkill", ["/pid", String(p.pid), "/f", "/t"]);
  } else {
    p.kill("SIGTERM", { forceKillAfterTimeout: 1_000 });
  }

  await channel.result;
};