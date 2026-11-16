// The benchmark's pages live with the benchmark, not in src/pages: this adds them to the site as
// /benchmark/ (all runs) and /benchmark/<run id>/ (one run, case by case).
export function benchmarkPages() {
  return {
    name: "benchmark-pages",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        injectRoute({ pattern: "/benchmark", entrypoint: "./benchmark/site/index.astro" });
        injectRoute({ pattern: "/benchmark/[run]", entrypoint: "./benchmark/site/run.astro" });
      },
    },
  };
}
