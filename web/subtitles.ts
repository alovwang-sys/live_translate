// 字幕：百炼把同一讲话人的连续讲话当成一个不断增长的条目，这里按句末标点自己切句。
// 全文按条目分段保留（用于复制/下载），屏幕上只显示最近 maxShown 句。

export class SubtitleTrack {
  /** 每个条目（一段连续讲话）一段，段内是已切好的句子 */
  private paragraphs: string[][] = [];
  private buffer = "";
  private itemId = "";
  /** 内容有变化时回调（用于保存记录） */
  onChange?: () => void;

  /** joiner 为 "auto" 时按前一句结尾判断：中日文后不加空格，其他加空格（纯转写可能中英混合） */
  constructor(
    private el: HTMLElement,
    private enders: RegExp,
    private joiner: string,
    private maxShown = 200,
  ) {}

  /** 纯转写：一个 item 就是一句话，text 是这句目前的完整内容（整句替换，不是增量）。 */
  setUtterance(itemId: string, text: string, final: boolean) {
    if (itemId !== this.itemId) {
      this.flush();
      this.itemId = itemId;
    }
    if (!this.paragraphs.length) this.paragraphs.push([]);
    this.buffer = text;
    if (final) {
      this.splitBuffer();
      this.flush();
      return this.onChange?.();
    }
    this.render();
    this.onChange?.();
  }

  push(itemId: string, delta: string) {
    if (itemId && itemId !== this.itemId) {
      this.flush();
      this.itemId = itemId;
      this.paragraphs.push([]);
    }
    if (!this.paragraphs.length) this.paragraphs.push([]);
    this.buffer += delta;
    this.splitBuffer();
    this.render();
    this.onChange?.();
  }

  /** 把 buffer 里已经说完的句子切出来提交，剩下半句留在 buffer。 */
  private splitBuffer() {
    let m: RegExpExecArray | null;
    while ((m = this.enders.exec(this.buffer))) {
      const end = m.index + m[0].length;
      this.commit(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
      this.enders.lastIndex = 0;
    }
  }

  private join(parts: string[]) {
    if (this.joiner !== "auto") return parts.join(this.joiner);
    return parts.reduce((acc, p) => (!acc ? p : acc + (/[\u3000-\u9fff\uff00-\uffef]$/.test(acc) ? "" : " ") + p), "");
  }

  /** 条目结束：剩下的半句也算一句。 */
  flush() {
    if (this.buffer.trim()) this.commit(this.buffer);
    this.buffer = "";
    this.render();
  }

  clear() {
    this.paragraphs = [];
    this.buffer = "";
    this.itemId = "";
    this.render();
  }

  /** 全文（含还没说完的半句），段与段之间空一行。 */
  text(): string {
    const paras = this.paragraphs.map((p) => this.join(p));
    if (this.buffer.trim()) {
      const last = paras.length ? paras.pop()! : "";
      paras.push(this.join([last, this.buffer.trim()].filter(Boolean)));
    }
    return paras.filter(Boolean).join("\n\n");
  }

  get empty() {
    return !this.buffer.trim() && this.paragraphs.every((p) => p.length === 0);
  }

  private commit(s: string) {
    const t = s.trim();
    if (t) this.paragraphs[this.paragraphs.length - 1].push(t);
  }

  private render() {
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    const shown = this.paragraphs.flat().slice(-this.maxShown);
    const frag = document.createDocumentFragment();
    for (const s of shown) {
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
/** 纯转写可能是任意语种：中文和西文句末标点都切 */
export const ANY_ENDERS = /[。！？]|[.!?](?=\s|$)/g;
