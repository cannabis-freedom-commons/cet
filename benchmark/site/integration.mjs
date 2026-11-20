// The benchmark's pages live with the benchmark, not in src/pages: this adds them to the site as
// the benchmark overview and detail pages for runs, models and cases.
export function benchmarkPages() {
  return {
    name: "benchmark-pages",
    hooks: {
      "astro:config:setup": ({ injectRoute }) => {
        injectRoute({ pattern: "/benchmark", entrypoint: "./benchmark/site/index.astro" });
        injectRoute({ pattern: "/benchmark/[run]", entrypoint: "./benchmark/site/run.astro" });
        injectRoute({ pattern: "/benchmark/model/[variant]", entrypoint: "./benchmark/site/model.astro" });
        injectRoute({ pattern: "/benchmark/case/[case]", entrypoint: "./benchmark/site/case.astro" });
      },
    },
  };
}
