import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// 门户自动化工作流状态仓库，与业务集合仓库独立，原子写入保证重启可回读。
export class BookingRepository {
  constructor(path) { this.path = path; }

  async read() {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Array.isArray(value.entries)) throw new Error('workflow file has no entries array');
      return value.entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async replace(entries) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ entries }, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }
}
