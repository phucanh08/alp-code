export const MAX_OUTPUT_REPAIR_ATTEMPTS = 1 as const;

export function canRepairOutput(repairAttempts: number): boolean {
  return repairAttempts < MAX_OUTPUT_REPAIR_ATTEMPTS;
}
