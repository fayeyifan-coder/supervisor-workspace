import { WorkspaceFault } from "./workspace-fault";

export class ProfileWriteGate {
  private writers = 0;
  private protecting = false;

  constructor(private readonly switching: () => boolean) {}

  get busy(): boolean { return this.protecting || this.writers !== 0; }

  async write<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.switching() || this.protecting) throw new WorkspaceFault("busy", "档案正在备份或切换，请完成后重试。");
    this.writers++;
    try { return await operation(); }
    finally { this.writers--; }
  }

  async protect<T>(operation: () => Promise<T>): Promise<T> {
    if (this.switching() || this.busy) throw new WorkspaceFault("busy", "仍有档案操作在进行，请等待完成后再试。");
    this.protecting = true;
    try { return await operation(); }
    finally { this.protecting = false; }
  }
}
