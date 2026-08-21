# RELATIONS — compaction

Compaction chỉ nhận thread/context bundle do `main` giao qua delegation launcher và trả một
context handoff trực tiếp cho `main`.

Không delegate cho ai. Việc yêu cầu giải bài toán, research hoặc ghi memory được trả lại cho
`main` cùng mô tả phần vượt phạm vi.
