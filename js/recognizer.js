/**
 * MathRecognizer v2 — 手写数学表达式识别器
 *
 * 采用「位图距离变换 + 字体原型 k-NN 分类」方案，彻底替换 v1 的纯规则启发式。
 *
 * 核心思想：
 *   1. 构建原型库：用系统自带的手写/无衬线字体渲染每个目标字符（数字、字母、符号），
 *      并做旋转、拉伸等增强，得到大量「标准手写参考样本」。
 *   2. 输入预处理：用户笔画 → 重采样 → 纵向投影分割成单个字符 → 栅格化位图
 *      → 归一化 → 距离变换（Chamfer）。
 *   3. 分类：用对称 Chamfer 距离在原型库中做 k-NN 加权投票，取胜出字符。
 *   4. 组装：词法容错修正（s1n→sin 等）+ 隐式乘号/函数括号补全。
 *
 * 相比 v1 对数字（0-9）和常见字母的识别稳定性大幅提升。
 */
class MathRecognizer {

    constructor() {
        this.S = 48;                 // 位图边长
        this.inner = 40;             // 墨水适配框（居中留边）
        this.built = false;
        this.prototypes = [];        // { cls, dt: Uint8ClampedArray, inkIdx: Int32Array }
        this.classes = [];

        this._tempCanvas = null;     // 原型渲染临时画布
        this._readyCbs = [];         // 原型库就绪回调

        this._startAsyncBuild();
    }

    /**
     * 异步构建原型库（不阻塞首屏）
     */
    _startAsyncBuild() {
        setTimeout(() => this._ensureBuilt(), 80);
    }

    _ensureBuilt() {
        if (!this.built) this._build();
    }

    /** 原型库就绪 Promise */
    whenReady() {
        if (this.built) return Promise.resolve();
        return new Promise(resolve => this._readyCbs.push(resolve));
    }

    /* ================= 字体检测 ================= */

    _fontAvailable(font) {
        try {
            const ctx = document.createElement('canvas').getContext('2d');
            const probe = 'mmmmmmmmmmlli';
            ctx.font = '72px serif';
            const w1 = ctx.measureText(probe).width;
            ctx.font = `72px '${font}', serif`;
            const w2 = ctx.measureText(probe).width;
            return w1 !== w2;
        } catch (e) {
            return false;
        }
    }

    _pickFonts() {
        const candidates = [
            'Segoe Script', 'Segoe Print', 'Ink Free', 'Comic Sans MS',
            'Kristen ITC', 'Bradley Hand ITC', 'Freestyle Script',
            'Brush Script MT', 'Lucida Handwriting', 'Monotype Corsiva',
            'Gabriola', 'French Script MT'
        ];
        const picked = [];
        for (const f of candidates) {
            if (this._fontAvailable(f)) picked.push(f);
            if (picked.length >= 6) break;
        }
        if (picked.length === 0) picked.push('italic serif', 'sans-serif');
        return picked;
    }

    /* ================= 原型库构建 ================= */

    _build() {
        const t0 = performance.now();
        const digits = '0123456789'.split('');
        const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
        const symbols = ['(', ')', '+', '-', '=', '/', '.', '^', 'π'];
        this.classes = [...digits, ...letters, ...symbols];

        const fonts = this._pickFonts();
        const rots = [0, 10, -10, 16];
        const scales = [1, 1.2];

        for (const cls of this.classes) {
            for (const font of fonts) {
                for (const rot of rots) {
                    for (const sx of scales) {
                        const proto = this._makeGlyphPrototype(cls, font, rot, sx);
                        if (proto) this.prototypes.push(proto);
                    }
                }
            }
        }

        this.built = true;
        this._readyCbs.forEach(cb => cb());
        this._readyCbs = [];
        const ms = Math.round(performance.now() - t0);
        console.log(`[MathRecognizer] 原型库构建完成：${this.prototypes.length} 个原型（${ms}ms）`);
    }

    _getTempCanvas() {
        if (!this._tempCanvas) {
            this._tempCanvas = document.createElement('canvas');
            this._tempCanvas.width = 128;
            this._tempCanvas.height = 128;
        }
        return this._tempCanvas;
    }

    /**
     * 用字体渲染一个字符 → 归一化 → 距离变换原型
     */
    _makeGlyphPrototype(char, font, rotDeg, sx) {
        const TS = 128;
        const tc = this._getTempCanvas();
        const tctx = tc.getContext('2d');
        tctx.clearRect(0, 0, TS, TS);
        tctx.save();
        tctx.translate(TS / 2, TS / 2);
        tctx.rotate(rotDeg * Math.PI / 180);
        tctx.scale(sx, 1);
        tctx.font = `42px '${font}', sans-serif`;
        tctx.textAlign = 'center';
        tctx.textBaseline = 'middle';
        tctx.fillStyle = '#000';
        tctx.fillText(char, 0, 2);
        tctx.restore();

        const img = tctx.getImageData(0, 0, TS, TS).data;
        let minX = TS, minY = TS, maxX = -1, maxY = -1;
        for (let y = 0; y < TS; y++) {
            for (let x = 0; x < TS; x++) {
                if (img[(y * TS + x) * 4 + 3] > 60) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null; // 该字体缺少此字符

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const scale = this.inner / Math.max(bw, bh);
        const dw = bw * scale;
        const dh = bh * scale;
        const dx = (this.S - dw) / 2;
        const dy = (this.S - dh) / 2;

        const bm = document.createElement('canvas');
        bm.width = this.S;
        bm.height = this.S;
        const bctx = bm.getContext('2d');
        bctx.clearRect(0, 0, this.S, this.S);
        bctx.drawImage(tc, minX, minY, bw, bh, dx, dy, dw, dh);
        const bdata = bctx.getImageData(0, 0, this.S, this.S).data;

        const binary = new Uint8Array(this.S * this.S);
        for (let i = 0; i < binary.length; i++) {
            binary[i] = bdata[i * 4 + 3] > 60 ? 1 : 0;
        }

        const { dt, inkIdx } = this._finalize(binary);
        return { cls: char, dt, inkIdx };
    }

    /**
     * 二值位图 → Chamfer 距离变换 + 墨水像素索引
     */
    _finalize(binary) {
        const S = this.S;
        const n = S * S;
        const dist = new Float32Array(n);
        const INF = 1e6;
        for (let i = 0; i < n; i++) dist[i] = binary[i] ? 0 : INF;

        const DIAG = 1.41421;
        // 前向扫描
        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                const i = y * S + x;
                if (y > 0)   { const v = dist[i - S] + 1;     if (v < dist[i]) dist[i] = v; }
                if (x > 0)   { const v = dist[i - 1] + 1;     if (v < dist[i]) dist[i] = v; }
                if (y > 0 && x > 0)     { const v = dist[i - S - 1] + DIAG; if (v < dist[i]) dist[i] = v; }
                if (y > 0 && x < S - 1) { const v = dist[i - S + 1] + DIAG; if (v < dist[i]) dist[i] = v; }
            }
        }
        // 后向扫描
        for (let y = S - 1; y >= 0; y--) {
            for (let x = S - 1; x >= 0; x--) {
                const i = y * S + x;
                if (y < S - 1)   { const v = dist[i + S] + 1;     if (v < dist[i]) dist[i] = v; }
                if (x < S - 1)   { const v = dist[i + 1] + 1;     if (v < dist[i]) dist[i] = v; }
                if (y < S - 1 && x < S - 1) { const v = dist[i + S + 1] + DIAG; if (v < dist[i]) dist[i] = v; }
                if (y < S - 1 && x > 0)     { const v = dist[i + S - 1] + DIAG; if (v < dist[i]) dist[i] = v; }
            }
        }

        const dt = new Uint8ClampedArray(n);
        for (let i = 0; i < n; i++) {
            dt[i] = dist[i] >= 30 ? 255 : Math.round(dist[i]);
        }

        const idx = [];
        for (let i = 0; i < n; i++) if (binary[i]) idx.push(i);
        return { dt, inkIdx: Int32Array.from(idx) };
    }

    /* ================= 主入口 ================= */

    /**
     * 识别手写笔画
     * @param {Array<Array<{x,y}>>} strokes
     * @param {{numeric?: boolean}} opts  numeric=true 时输出偏向数字（用于积分上下限）
     */
    recognize(strokes, opts = {}) {
        if (!this.built) this._ensureBuilt();

        if (!strokes || strokes.length === 0) {
            return { expression: '', confidence: 0, details: [] };
        }

        const cleaned = strokes
            .map(s => this._resampleStroke(s))
            .filter(s => s.length > 0 && (this._strokeLength(s) >= 2 || s.length === 1));

        if (cleaned.length === 0) {
            return { expression: '', confidence: 0, details: [] };
        }

        // 字符分割
        const charGroups = this._segmentCharacters(cleaned);

        // 逐字符分类
        const details = [];
        for (const seg of charGroups) {
            const feat = this._rasterizeInput(seg.strokes);
            if (!feat || feat.inkIdx.length < 3) {
                details.push({ char: '?', confidence: 0, bbox: seg.bbox });
                continue;
            }
            const res = this._classifyBitmap(feat);
            details.push({ char: res.char, confidence: res.confidence, bbox: seg.bbox });
        }

        let expression = this._assembleExpression(details);

        if (opts.numeric) {
            expression = this._numericClean(expression);
        }

        const avgConfidence =
            details.reduce((s, d) => s + d.confidence, 0) / Math.max(1, details.length);

        return {
            expression,
            confidence: Math.round(avgConfidence * 1000) / 1000,
            details,
        };
    }

    /* ================= 笔画预处理 ================= */

    _resampleStroke(points) {
        if (points.length <= 1) return points;
        const result = [points[0]];
        let accumulated = 0;
        for (let i = 1; i < points.length; i++) {
            const dx = points[i].x - points[i - 1].x;
            const dy = points[i].y - points[i - 1].y;
            const d = Math.sqrt(dx * dx + dy * dy);
            accumulated += d;
            while (accumulated >= 4) {
                accumulated -= 4;
                const t = 1 - accumulated / d;
                result.push({
                    x: points[i - 1].x + dx * t,
                    y: points[i - 1].y + dy * t
                });
            }
        }
        result.push(points[points.length - 1]);
        return result;
    }

    _strokeLength(points) {
        let len = 0;
        for (let i = 1; i < points.length; i++) {
            len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        }
        return len;
    }

    /* ================= 字符分割（纵向投影谷底） ================= */

    _segmentCharacters(strokes) {
        if (!strokes || strokes.length === 0) return [];
        if (strokes.length === 1) {
            return [{ strokes, bbox: this._bboxOfStrokes(strokes) }];
        }

        // 全局边界
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of strokes) {
            for (const p of s) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
        }
        const W = Math.max(8, maxX - minX + 1);
        const H = Math.max(8, maxY - minY + 1);

        // 纵向投影（按列统计墨水量）
        const COLS = Math.min(240, Math.max(16, Math.round(W)));
        const counts = new Float64Array(COLS);
        for (const s of strokes) {
            for (const p of s) {
                let c = Math.floor((p.x - minX) / W * COLS);
                if (c >= COLS) c = COLS - 1;
                if (c < 0) c = 0;
                counts[c] += 1;
            }
        }
        // 平滑
        const sm = new Float64Array(COLS);
        for (let c = 0; c < COLS; c++) {
            let acc = 0, n = 0;
            for (let d = -1; d <= 1; d++) {
                const cc = c + d;
                if (cc >= 0 && cc < COLS) { acc += counts[cc]; n++; }
            }
            sm[c] = n > 0 ? acc / n : 0;
        }

        const maxCount = Math.max(...sm);
        if (maxCount <= 0) return [{ strokes, bbox: this._bboxOfStrokes(strokes) }];

        // 低于阈值的列为「谷底」
        const thresh = Math.max(maxCount * 0.045, 0.6);
        const gaps = [];
        let inGap = false, start = 0;
        for (let c = 0; c < COLS; c++) {
            if (sm[c] < thresh) {
                if (!inGap) { inGap = true; start = c; }
            } else {
                if (inGap) { gaps.push([start, c - 1]); inGap = false; }
            }
        }
        if (inGap) gaps.push([start, COLS - 1]);

        // 过窄的谷底不算分隔符
        const minGapPx = Math.max(1.0, W * 0.018);
        const segBounds = [];
        let prev = 0;
        for (const [gs, ge] of gaps) {
            const gapWpx = (ge - gs + 1) / COLS * W;
            if (gapWpx < minGapPx) continue;
            const splitCol = (gs + ge) / 2;
            const splitX = minX + splitCol / COLS * W;
            if (splitX > prev) segBounds.push({ from: prev, to: splitX });
            prev = splitX;
        }
        segBounds.push({ from: prev, to: Infinity });

        // 笔画按质心 x 归入段
        const segs = segBounds.map(() => []);
        for (const s of strokes) {
            let sum = 0, n = 0;
            for (const p of s) { sum += p.x; n++; }
            const cx = sum / Math.max(1, n);
            for (let k = 0; k < segBounds.length; k++) {
                const b = segBounds[k];
                if (cx >= b.from && cx <= b.to) { segs[k].push(s); break; }
            }
        }
        const nonEmpty = segs.filter(seg => seg.length > 0);

        // 合并零星墨点（如字母 i 上方的点）到最近的段
        if (nonEmpty.length > 1) {
            for (let i = 0; i < nonEmpty.length; i++) {
                let ink = 0;
                for (const s of nonEmpty[i]) ink += s.length;
                if (ink <= 3) {
                    // 找最近的段合并
                    let bestJ = -1, bestD = Infinity;
                    for (let j = 0; j < nonEmpty.length; j++) {
                        if (j === i) continue;
                        const d = this._segDistance(nonEmpty[i], nonEmpty[j]);
                        if (d < bestD) { bestD = d; bestJ = j; }
                    }
                    if (bestJ >= 0) {
                        nonEmpty[bestJ].push(...nonEmpty[i]);
                        nonEmpty[i] = [];
                    }
                }
            }
        }

        return nonEmpty
            .filter(seg => seg.length > 0)
            .map(seg => ({ strokes: seg, bbox: this._bboxOfStrokes(seg) }));
    }

    _bboxOfStrokes(strokes) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of strokes) {
            for (const p of s) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
        }
        return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    }

    _segDistance(segsA, segsB) {
        let best = Infinity;
        for (const a of segsA) {
            for (const b of segsB) {
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                if (d < best) best = d;
            }
        }
        return best;
    }

    /* ================= 输入栅格化 ================= */

    _rasterizeInput(strokes) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of strokes) {
            for (const p of s) {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            }
        }
        const w = Math.max(1, maxX - minX);
        const h = Math.max(1, maxY - minY);
        const pad = Math.max(w, h) * 0.06 + 1;
        const scale = this.inner / Math.max(w + pad * 2, h + pad * 2);
        const off = (this.S - this.inner) / 2;

        const bm = document.createElement('canvas');
        bm.width = this.S;
        bm.height = this.S;
        const ctx = bm.getContext('2d');
        ctx.clearRect(0, 0, this.S, this.S);
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#000';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const lw = Math.min(4.5, Math.max(1.6, scale * 2.6));
        ctx.lineWidth = lw;

        const mx = (x) => (x - minX + pad) * scale + off;
        const my = (y) => (y - minY + pad) * scale + off;

        for (const s of strokes) {
            if (s.length === 1) {
                ctx.beginPath();
                ctx.arc(mx(s[0].x), my(s[0].y), lw / 2, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.beginPath();
                ctx.moveTo(mx(s[0].x), my(s[0].y));
                for (let i = 1; i < s.length; i++) {
                    ctx.lineTo(mx(s[i].x), my(s[i].y));
                }
                ctx.stroke();
            }
        }

        const data = ctx.getImageData(0, 0, this.S, this.S).data;
        const binary = new Uint8Array(this.S * this.S);
        let inkCount = 0;
        for (let i = 0; i < binary.length; i++) {
            if (data[i * 4 + 3] > 60) { binary[i] = 1; inkCount++; }
        }
        if (inkCount < 3) return null;

        return this._finalize(binary);
    }

    /* ================= k-NN 分类 ================= */

    _classifyBitmap(feat) {
        const { dt, inkIdx } = feat;
        const nInk = inkIdx.length;
        const protos = this.prototypes;

        // 对称 Chamfer 距离
        const scores = new Float32Array(protos.length);
        for (let p = 0; p < protos.length; p++) {
            const pr = protos[p];
            let score = 0;
            const pdt = pr.dt;
            for (let a = 0; a < nInk; a++) score += pdt[inkIdx[a]];
            const qdt = dt;
            const qInk = pr.inkIdx;
            for (let b = 0; b < qInk.length; b++) score += qdt[qInk[b]];
            scores[p] = score / (nInk + qInk.length);
        }

        // 选出距离最小的 k 个
        const k = 7;
        const kth = new Float32Array(k).fill(Infinity);
        const kcls = new Array(k).fill(null);
        for (let p = 0; p < protos.length; p++) {
            const sc = scores[p];
            for (let j = 0; j < k; j++) {
                if (sc < kth[j]) {
                    for (let jj = k - 1; jj > j; jj--) {
                        kth[jj] = kth[jj - 1];
                        kcls[jj] = kcls[jj - 1];
                    }
                    kth[j] = sc;
                    kcls[j] = protos[p].cls;
                    break;
                }
            }
        }

        // 按类加权投票（距离越小权重越大）
        const votes = {};
        for (let j = 0; j < k; j++) {
            const cls = kcls[j];
            if (cls === null) break;
            const w = 1 / (kth[j] + 0.4);
            votes[cls] = (votes[cls] || 0) + w;
        }
        let bestCls = null, bestW = -1;
        for (const c in votes) {
            if (votes[c] > bestW) { bestW = votes[c]; bestCls = c; }
        }
        let secondW = 0;
        for (const c in votes) {
            if (c !== bestCls && votes[c] > secondW) secondW = votes[c];
        }

        let conf = (bestW - secondW) / bestW;
        const bestScore = kth[0];
        if (bestScore > 2.2) conf *= 0.7;
        if (bestScore > 3.5) conf *= 0.5;
        conf = Math.max(0, Math.min(1, conf));

        return { char: bestCls, confidence: conf, score: bestScore };
    }

    /* ================= 表达式组装 ================= */

    _assembleExpression(details) {
        // 上标/下标检测（基于每个字符的边界框）
        this._detectRoles(details);

        let raw = '';
        for (const d of details) {
            if (d.role === 'sup') raw += '^';
            else if (d.role === 'sub') raw += '_';
            raw += d.char;
        }

        raw = this._fixWordPatterns(raw);
        if (details.length === 1 && raw.length === 1) {
            raw = this._singleCharFix(raw, details[0].confidence);
        }
        // 先处理下标，避免之后的乘号插入破坏 log_a(b) 结构
        raw = this._handleSubscripts(raw);
        return this._insertMultiplications(raw);
    }

    /**
     * 上标/下标检测：
     * 某个字符如果明显更小、且位置明显偏高（上标）或偏低（下标），
     * 在它前面补上 ^ 或 _。例如手写 x² → "x^2"。
     */
    _detectRoles(details) {
        const bboxes = details.map(d => d.bbox).filter(Boolean);
        if (bboxes.length < 2) return;

        // 参考字符高度（中位数）
        const heights = bboxes.map(b => b.maxY - b.minY);
        heights.sort((a, b) => a - b);
        const medianH = heights[Math.floor(heights.length / 2)] || 1;

        // 基线 = 正常大小字符的底部中位数
        const normalBottoms = bboxes
            .filter(b => (b.maxY - b.minY) > medianH * 0.8)
            .map(b => b.maxY);
        let baseline;
        if (normalBottoms.length > 0) {
            normalBottoms.sort((a, b) => a - b);
            baseline = normalBottoms[Math.floor(normalBottoms.length / 2)];
        } else {
            baseline = Math.max(...bboxes.map(b => b.maxY));
        }

        // 中线 = 基线 - 半个字符高
        const midline = baseline - medianH / 2;

        for (const d of details) {
            if (!d.bbox) continue;
            const h = d.bbox.maxY - d.bbox.minY;
            const center = (d.bbox.maxY + d.bbox.minY) / 2;
            // 已经是明确的上标符号 ^ 就不再标记
            if (d.char === '^' || d.char === "'") continue;
            if (h < medianH * 0.78) {
                if (center < midline - medianH * 0.05) {
                    d.role = 'sup';      // 明显高于中线 → 上标
                } else if (center > baseline + medianH * 0.15) {
                    d.role = 'sub';      // 明显低于基线 → 下标
                }
            }
        }
    }

    /**
     * 处理下标：如 log_2(x) → log(x, 2)；其余 _ 直接去掉避免语法错误
     */
    _handleSubscripts(expr) {
        if (!expr.includes('_')) return expr;
        let s = expr;
        s = s.replace(/(log|ln)_([a-z0-9]+)\(([^)]*)\)/g, '$1($3, $2)');
        s = s.replace(/_/g, '');
        return s;
    }

    _singleCharFix(ch, conf) {
        if (conf >= 0.62) return ch;
        const map = { o: '0', O: '0', l: '1', I: '1', z: '2', Z: '2', s: '5', S: '5', q: '9', Q: '9', g: '9', b: '6', B: '8' };
        return map[ch] || ch;
    }

    _fixWordPatterns(raw) {
        let s = raw;
        const fixes = [
            [/sqr|sqrtt|sqr1|sqrt/g, 'sqrt'],
            [/s1n|s0n|sln/g, 'sin'],
            [/c0s|c05/g, 'cos'],
            [/t4n|t0n/g, 'tan'],
            [/l0g|10g|1og/g, 'log'],
            [/1n|In/g, 'ln'],
            [/ex0/g, 'exp'],
            [/a1s/g, 'abs'],
            [/p1|pl|π/g, 'pi'],
            [/[A-Z]/g, (m) => m.toLowerCase()],
        ];
        for (const [re, rep] of fixes) s = s.replace(re, rep);
        return s;
    }

    _insertMultiplications(raw) {
        let s = raw;
        // 字母/数字/右括号 紧接已知函数名 → 补乘号：xsin → x*sin
        s = s.replace(/([a-zπ0-9)])(sin|cos|tan|log|ln|sqrt|exp|abs)/g, '$1*$2');
        // 已知函数名直接跟变量/数字 → 加括号：sinx → sin(x)
        s = s.replace(/(sin|cos|tan|log|ln|sqrt|exp|abs)([a-zπ0-9.])/g, '$1($2)');
        // 常数 pi 后接内容 → 补乘号：pix → pi*x
        s = s.replace(/(pi)([a-zπ0-9])/g, '$1*$2');
        // 数字后接字母/左括号：2x → 2*x
        s = s.replace(/(\d)([a-zπ(])/g, '$1*$2');
        // 字母/右括号后接数字：x2 → x*2
        s = s.replace(/([a-zπ)])(\d)/g, '$1*$2');
        // 右括号后接内容：)x → )*x
        s = s.replace(/\)([a-zπ0-9])/g, ')*$1');
        return s;
    }

    /**
     * 数字模式清洗：用于积分上下限，输出只保留数字/小数点/运算/pi/e
     */
    _numericClean(expr) {
        let s = expr;
        s = s.replace(/π/g, 'P');
        s = s.replace(/pi|p1|pl/g, 'P');
        s = s.replace(/e/g, 'E');
        s = s.replace(/o/g, '0').replace(/O/g, '0')
            .replace(/l/g, '1').replace(/I/g, '1')
            .replace(/z/g, '2').replace(/Z/g, '2')
            .replace(/s/g, '5').replace(/S/g, '5')
            .replace(/b/g, '6')
            .replace(/q/g, '9').replace(/Q/g, '9')
            .replace(/g/g, '9')
            .replace(/[?=<>]/g, '');
        s = s.replace(/[^0-9.+\-*/()^PE]/g, '');
        s = s.replace(/P/g, 'pi').replace(/E/g, 'e');
        return s;
    }
}

// 全局导出
window.MathRecognizer = MathRecognizer;
