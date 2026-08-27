export class InvalidPolicyStateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPolicyStateError";
  }
}
