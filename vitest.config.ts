import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // `.worktrees/` là checkout của nhánh khác (gitignored). Không loại thì `npm test`
    // chạy luôn test của nhánh đó — kể cả việc chưa commit — và báo đỏ cho nhánh này.
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
