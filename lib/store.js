// 기록 저장소. 모든 기록은 data/ideas.json 하나에 저장되고,
// 첨부 파일은 data/uploads/ 에 원본 그대로 보관된다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.uploadDir = path.join(dataDir, 'uploads');
    this.file = path.join(dataDir, 'ideas.json');
    fs.mkdirSync(this.uploadDir, { recursive: true });
    this.ideas = [];
    if (fs.existsSync(this.file)) {
      this.ideas = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    }
    // 서버가 작업 도중 꺼졌다면 진행 중이던 작업을 대기열로 되돌린다.
    for (const idea of this.ideas) {
      if (idea.status === 'running') idea.status = 'queued';
      if (idea.threadStatus === 'running') idea.threadStatus = 'queued';
    }
  }

  static newId() {
    // 시간순 정렬이 되도록 시각 + 난수
    return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.ideas, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return [...this.ideas].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    return this.ideas.find((i) => i.id === id) || null;
  }

  create(idea) {
    this.ideas.push(idea);
    this.save();
    return idea;
  }

  update(id, fn) {
    const idea = this.get(id);
    if (!idea) return null;
    fn(idea);
    idea.updatedAt = new Date().toISOString();
    this.save();
    return idea;
  }

  remove(id) {
    const idea = this.get(id);
    if (!idea) return false;
    for (const att of idea.raw.attachments || []) {
      for (const f of [att.file, ...(att.frames || [])]) {
        fs.rmSync(path.join(this.uploadDir, f), { force: true });
      }
    }
    this.ideas = this.ideas.filter((i) => i.id !== id);
    this.save();
    return true;
  }

  uploadPath(file) {
    return path.join(this.uploadDir, file);
  }
}
