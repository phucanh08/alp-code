import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `.worktrees/` là checkout của nhánh khác (gitignored). Không loại thì `npm test`
    // chạy luôn test của nhánh đó — kể cả việc chưa commit — và báo đỏ cho nhánh này.
    // `test/fixtures/live/` là project mẫu cho tầng 4 (live): test *của nó* chạy bằng
    // `node --test` trong chính thư mục đó, không phải bằng vitest.
    exclude: [...configDefaults.exclude, ".worktrees/**", "test/fixtures/live/**"],
  },
});
