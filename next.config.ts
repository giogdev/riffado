import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

/**
 * PostHog reverse-proxy destination. Read directly from `process.env`
 * (not `@/lib/env`) because this file is evaluated during `next build`
 * as well as at runtime, and `@/lib/env` throws on missing
 * runtime-only vars during the build phase. Defaults to the EU
 * ingest cluster, matching the hardcoded value this replaces.
 */
const posthogHost = process.env.POSTHOG_HOST ?? "https://eu.i.posthog.com";
const posthogAssetsHost = posthogHost.replace(
    ".i.posthog.com",
    "-assets.i.posthog.com",
);

const nextConfig: NextConfig = {
    output: "standalone",
    // Client source maps are only ever generated when the build is going
    // to inject+upload+delete them (see the guarded `posthog-cli` step in
    // the Dockerfile builder stage). Without `POSTHOG_CLI_API_KEY`, Next
    // never emits `.js.map` files at all, so there's nothing a self-host
    // build could accidentally ship publicly-servable.
    productionBrowserSourceMaps: Boolean(process.env.POSTHOG_CLI_API_KEY),
    async rewrites() {
        return [
            {
                source: "/psthg/static/:path*",
                destination: `${posthogAssetsHost}/static/:path*`,
            },
            {
                source: "/psthg/array/:path*",
                destination: `${posthogAssetsHost}/array/:path*`,
            },
            {
                source: "/psthg/:path*",
                destination: `${posthogHost}/:path*`,
            },
        ];
    },
    skipTrailingSlashRedirect: true,
    // `scripts/install.sh` is read from disk at request time by the
    // /install.sh routes; declare it so the standalone tracer ships it.
    outputFileTracingIncludes: {
        "/install.sh": ["./scripts/install.sh"],
        "/[version]/install.sh": ["./scripts/install.sh"],
    },
    images: {
        loader: "custom",
        loaderFile: "./loader.ts",
        remotePatterns: [],
    },
    // @xenova/transformers statically imports Node-only optional deps
    // (`onnxruntime-node`, `sharp`). Browser transcription uses
    // `onnxruntime-web` inside a Web Worker, so stub those native deps
    // for both Next 16's Turbopack build path and the webpack fallback.
    turbopack: {
        resolveAlias: {
            "onnxruntime-node": "./src/lib/transcription/empty-module.ts",
            sharp: "./src/lib/transcription/empty-module.ts",
        },
    },
    webpack: (config) => {
        config.resolve = config.resolve ?? {};
        config.resolve.alias = {
            ...config.resolve.alias,
            "onnxruntime-node": false,
            sharp: false,
        };
        return config;
    },
};

const withMDX = createMDX({ outDir: "src/.source" });

export default withMDX(nextConfig);
