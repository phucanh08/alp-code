// Chạy một fixture TypeScript trong một process Node thật.
//
// Vitest transpile test trong process của nó, nên một fixture cần *process riêng* — thứ duy
// nhất chứng minh được hai CLI process không nuốt update của nhau — thì không đi qua đường đó.
// Build cả `dist/` chỉ để có một file thì chậm và buộc gate phải build trước khi test.
// `typescript` đã là devDependency, và `transpileModule` bỏ qua type check nên nó tốn vài
// mili-giây: fixture vẫn được `npm run typecheck` soi như mọi file khác, chỉ là không phải ở đây.

"use strict";

const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const ts = require("typescript");

const compilerOptions = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
};

require.extensions[".ts"] = (module, filename) => {
  const source = readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions, fileName: filename });
  module._compile(outputText, filename);
};

require(resolve(process.argv[2]));
