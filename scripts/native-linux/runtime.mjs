// Runtime evidence uses the exact executable that runs native TypeScript.
console.log(
  JSON.stringify({
    node: process.version,
    sqlite: process.versions.sqlite,
    platform: process.platform,
    arch: process.arch,
  }),
);
