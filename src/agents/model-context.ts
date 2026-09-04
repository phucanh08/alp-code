/**
 * Cửa sổ context của từng model, tính bằng token — mẫu số cho vai không khai
 * `autoCompactTokens`.
 *
 * Im lặng trước đây có nghĩa là "tuỳ runtime", mà hai runtime quyết khác nhau: Codex nén ở
 * 90% cửa sổ context của model, còn Claude nén ở cửa sổ nó tự tune theo model và theo
 * settings của chính máy đang chạy. Cùng một vai lại nhớ được nhiều ít khác nhau tuỳ chỗ
 * chạy — đúng cái phụ thuộc-vào-máy mà việc khai ngưỡng trên vai sinh ra để chấm dứt. Nên
 * ALP tự quyết mặc định: 90% cửa sổ dưới đây, giống nhau trên cả hai runtime.
 *
 * Con số là cửa sổ nhà cung cấp công bố, không phải ước lượng. Model nào không có ở đây thì
 * không có mặc định — để runtime dùng cửa sổ của nó còn hơn dựng một ngân sách từ phỏng
 * đoán.
 */

/** Phần trăm cửa sổ được giữ trước khi runtime được phép nén — chính con số Codex đang dùng. */
export const AUTO_COMPACT_DEFAULT_PERCENT = 90;

export const MODEL_CONTEXT_WINDOWS: Readonly<Record<string, number>> = Object.freeze({
  // 1M token native, standard pricing (claude.com/docs — Opus 5, Sonnet 5). Claude vẫn cap
  // lại theo cửa sổ thật của phiên, nên số này là trần chứ không phải lời hứa.
  "claude-opus-5": 1_000_000,
  "claude-sonnet-5": 1_000_000,
  "claude-haiku-4-5": 200_000,
  // Đo từ `~/.codex/models_cache.json` (codex-cli 0.149.0): `context_window` 272000 cho cả
  // ba, `max_context_window` 872000 chỉ mở khi tài khoản có quyền — lấy cửa sổ đang hoạt
  // động, vì nén sớm còn cứu được, nén muộn thì mất.
  "gpt-5.6-sol": 272_000,
  "gpt-5.6-terra": 272_000,
  "gpt-5.6-luna": 272_000,
});

/**
 * Ngưỡng mặc định cho một model, hoặc `null` nếu ALP không biết cửa sổ của nó.
 *
 * Nhân rồi chia số nguyên: `window * 0.9` trả về 244800.00000000003 cho cửa sổ 272k, và một
 * ngưỡng token lẻ là thứ không runtime nào làm tròn giúp.
 */
export function defaultAutoCompactTokens(model: string): number | null {
  const window = MODEL_CONTEXT_WINDOWS[model];
  return window === undefined ? null : Math.floor((window * AUTO_COMPACT_DEFAULT_PERCENT) / 100);
}
