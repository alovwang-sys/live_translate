// 字幕：百炼把同一讲话人的连续讲话当成一个不断增长的条目，这里按句末标点自己切句。

export class SubtitleTrack {
  private sentences: string[] = [];
  private buffer = "";
  private itemId = "";

  constructor(
    private el: HTMLElement,
    private enders: RegExp,
    private maxSentences = 200,
  ) {}

  push(itemId: string, delta: string) {
    if (itemId && itemId !== this.itemId) {
      this.flush();
      this.itemId = itemId;
    }
    this.buffer += delta;
    let m: RegExpExecArray | null;
    while ((m = this.enders.exec(this.buffer))) {
      const end = m.index + m[0].length;
      this.commit(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
      this.enders.lastIndex = 0;
    }
    this.render();
  }

  /** 条目结束：剩下的半句也算一句。 */
  flush() {
    if (this.buffer.trim()) this.commit(this.buffer);
    this.buffer = "";
    this.render();
  }

  clear() {
    this.sentences = [];
    this.buffer = "";
    this.itemId = "";
    this.render();
  }

  private commit(s: string) {
    const t = s.trim();
    if (!t) return;
    this.sentences.push(t);
    if (this.sentences.length > this.maxSentences) this.sentences.shift();
  }

  private render() {
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const s of this.sentences) {
      const p = document.createElement("p");
      p.textContent = s;
      frag.append(p);
    }
    if (this.buffer.trim()) {
      const p = document.createElement("p");
      p.className = "partial";
      p.textContent = this.buffer.trim();
      frag.append(p);
    }
    this.el.replaceChildren(frag);
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }
}

export const ZH_ENDERS = /[。！？!?]/g;
export const EN_ENDERS = /[.!?](?=\s|$)/g;
