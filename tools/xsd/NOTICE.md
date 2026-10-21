# 第三方素材

## mxfile.xsd

- **用途**：`typescript/test/xsd.test.ts` 用它校验生成的 `.drawio` 是否符合 draw.io 官方 schema。
- **来源**：[drawio-mcp](https://gitcode.com/gh_mirrors/dr/drawio-mcp)（上游 jgraph/drawio-mcp），`shared/mxfile.xsd`
- **上游提交**：`3544efc144670bd52f06cff345b048d94f65f3f4`
- **许可**：Apache License 2.0（见 drawio-mcp 仓库 `LICENSE`）
- **SHA-256**：`903DE40A27226B7B4B978CC6DF9928C9E07A8710C2BF004875E465F90251A70C`
- **大小**：30170 字节

复制而非引用：原实现从同级目录的 `drawio-mcp/` 仓库取它，克隆本仓库的人不会有那个目录，测试会静默 skip（实测跳过 3 条）。vendor 进来后这 3 条真正执行。

XSD 头部注释自述 "*It is intended for use by AI systems to validate generated diagram files*"，与本仓库用法一致。
