#!/usr/bin/env node
// test-delegation.cjs — contract ủy nhiệm + luật định tuyến pane/exec.
//
// Luật định tuyến là thứ dễ trôi nhất trong cả hệ: nó không gây lỗi khi sai, chỉ khiến
// cùng một hình dạng việc đi hai đường khác nhau giữa hai phiên. Nên nó phải có test.

const assert = require("assert");
const os = require("os");
const { wrapDelegatedPrompt, delegatedPromptPointer } = require("./lib/delegation.cjs");
const F = require("./lib/herdr-fleet.cjs");

// ---------------------------------------------------------------- contract

const prompt = wrapDelegatedPrompt("Tìm luồng authentication");
assert(prompt.includes("do `main` (Phở 🍜) giao"));
assert(prompt.includes("chỉ gửi về `main`"));
assert(prompt.includes("không giao tiếp trực tiếp với principal"));
assert(prompt.endsWith("Tìm luồng authentication"));

// Bản một dòng phải giữ NGUYÊN nguồn ủy nhiệm. Bỏ nó đi thì vai phụ thấy một nhiệm vụ
// không rõ nguồn và từ chối theo luật main-only — đã đo thật trên pane Titling.
const pointer = delegatedPromptPointer("/tmp/x.md");
assert(!pointer.includes("\n"), "prompt gửi vào pane phải MỘT dòng — herdr từ chối newline");
assert(pointer.includes("do `main` (Phở 🍜) giao"));
assert(pointer.includes("chỉ gửi về `main`"));
assert(pointer.includes("/tmp/x.md"));

// ---------------------------------------------------------------- luật định tuyến

const ROUTES = [
  [{ roles: 2, minutes: 0.5 }, "pane", "hai vai song song"],
  [{ roles: 3, minutes: 10 }, "pane", "ba vai, việc dài"],
  [{ roles: 1, minutes: 5 }, "pane", "một vai nhưng >1 phút"],
  [{ roles: 1, minutes: 0.5, interactive: true }, "pane", "cần theo dõi giữa chừng"],
  [{ roles: 1, minutes: 0.5, concerns: 3 }, "pane", "review nhiều concern"],
  [{ roles: 1, minutes: 0.5 }, "exec", "một câu hỏi, đồng bộ, <1 phút"],
  [{}, "exec", "mặc định = việc nhỏ nhất"],
  // Không fleet thì MỌI hình dạng đều về exec — kể cả hình dạng đáng lẽ đi pane.
  [{ roles: 4, minutes: 30, interactive: true, fleet: false }, "exec", "headless: không có pane để mở"],
];

for (const [shape, want, label] of ROUTES) {
  const got = F.route(shape);
  assert.strictEqual(got.via, want, `${label}: cần ${want}, thực tế ${got.via} (${got.why})`);
  assert(got.why, `${label}: thiếu lý do — luật im lặng là luật không debug được`);
}

// ---------------------------------------------------------------- arg nhiều dòng

// herdr từ chối arg có xuống dòng; wrapper phải tự đưa ra file, không để caller nhớ.
const multi = wrapDelegatedPrompt("Việc\nnhiều dòng");
const ext = F.externalizeArgs(["-p", "search", multi], "test-x", delegatedPromptPointer);
assert.strictEqual(ext.files.length, 1, "prompt nhiều dòng phải được ghi ra đúng một file");
assert(ext.argv.every((a) => !a.includes("\n")), "sau externalize không được còn newline nào");
assert(ext.argv[2].includes(ext.files[0]), "dòng thay thế phải trỏ tới file vừa ghi");
assert(ext.argv[2].includes("do `main` (Phở 🍜) giao"), "dòng thay thế phải mang nguồn ủy nhiệm");
assert(require("fs").readFileSync(ext.files[0], "utf8").includes("Việc\nnhiều dòng"));
assert(ext.files[0].startsWith(os.tmpdir()), "file nhiệm vụ là thứ dùng một lần — không nằm trong repo");
require("fs").rmSync(ext.files[0], { force: true });

// Arg một dòng thì KHÔNG được đụng vào: mọi lần ghi file thừa là một lần vai phải đọc thêm.
const plain = F.externalizeArgs(["-p", "search", "việc ngắn"], "test-y");
assert.deepStrictEqual(plain.argv, ["-p", "search", "việc ngắn"]);
assert.strictEqual(plain.files.length, 0);

// ---------------------------------------------------------------- seq

// Seq cũ hoặc BẰNG bị herdr bỏ qua im lặng — nên "tăng nghiêm ngặt" là điều kiện đúng,
// không phải "không giảm".
let prev = F.nextSeq();
for (let i = 0; i < 50; i++) {
  const next = F.nextSeq();
  assert(next > prev, `seq phải TĂNG nghiêm ngặt: ${next} không lớn hơn ${prev}`);
  prev = next;
}

console.log("OK               delegation: contract · luật định tuyến · arg nhiều dòng · seq");
