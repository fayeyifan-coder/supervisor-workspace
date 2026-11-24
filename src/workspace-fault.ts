import type { Failure } from "./contracts";

export class WorkspaceFault extends Error {
  constructor(readonly code: Failure["code"], message: string) {
    super(message);
  }
}
