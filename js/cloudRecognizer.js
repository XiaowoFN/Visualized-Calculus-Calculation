/**
 * CloudRecognizer — MyScript 云手写数学识别封装
 *
 * 使用 iinkTS（官方 Web SDK）的 INTERACTIVEINKSSR 模式：
 *   - 服务端渲染：无需本地画布 UI，直接喂入笔画即可
 *   - 识别类型：MATH，输出 LaTeX（application/x-latex）
 *   - 凭据：applicationKey + hmacKey（免费注册 MyScript 开发者账号获得）
 *
 * 设计：
 *   - 懒加载 SDK（首次识别时注入 <script>）
 *   - 懒创建编辑器（隐藏容器，SSR 不渲染）
 *   - 识别请求排队串行，避免并发冲突
 *   - 失败/未配置时返回 null，由调用方回退本地识别
 */
class CloudRecognizer {

    constructor() {
        this.server = null;         // { scheme, host, applicationKey, hmacKey }
        this.editor = null;
        this.sdkLoaded = false;
        this.verified = false;      // 是否已通过测试验证
        this._queue = Promise.resolve();
        this._statusListeners = [];

        this._loadServer();
    }

    /* ================= 配置持久化 ================= */

    _loadServer() {
        try {
            const raw = localStorage.getItem('myscript_server');
            if (raw) {
                const s = JSON.parse(raw);
                if (s && s.applicationKey && s.hmacKey) {
                    this.server = {
                        scheme: s.scheme || 'https',
                        host: s.host || 'cloud.myscript.com',
                        applicationKey: String(s.applicationKey).trim(),
                        hmacKey: String(s.hmacKey).trim(),
                    };
                }
            }
        } catch (e) {
            this.server = null;
        }
    }

    saveServer({ applicationKey, hmacKey, host, scheme }) {
        this.server = {
            scheme: scheme || 'https',
            host: host || 'cloud.myscript.com',
            applicationKey: String(applicationKey).trim(),
            hmacKey: String(hmacKey).trim(),
        };
        try {
            localStorage.setItem('myscript_server', JSON.stringify(this.server));
        } catch (e) {}
        this.verified = false;
        this._resetEditor();
        this._notifyStatus();
    }

    clearServer() {
        this.server = null;
        this.verified = false;
        try {
            localStorage.removeItem('myscript_server');
        } catch (e) {}
        this._resetEditor();
        this._notifyStatus();
    }

    isConfigured() {
        return !!this.server;
    }

    isVerified() {
        return this.verified;
    }

    getStatus() {
        if (!this.server) return 'not-configured';
        if (!this.sdkLoaded || !this.editor) return 'loading';
        return 'ready';
    }

    onStatus(cb) {
        this._statusListeners.push(cb);
    }

    _notifyStatus() {
        const status = this.getStatus();
        this._statusListeners.forEach(cb => cb(status));
    }

    /* ================= SDK 与编辑器 ================= */

    _loadSDK() {
        if (this.sdkLoaded || window.iink) {
            this.sdkLoaded = true;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/iink-ts@3.3.2/dist/iink.min.js';
            script.onload = () => {
                this.sdkLoaded = true;
                this._notifyStatus();
                resolve();
            };
            script.onerror = () => {
                reject(new Error('无法加载 iink-ts SDK（请检查网络）'));
            };
            document.head.appendChild(script);
        });
    }

    _resetEditor() {
        this.editor = null;
        this._editorFailed = null;
    }

    /**
     * 给任意 Promise 加超时
     */
    _withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('超时（' + Math.round(ms / 1000) + '秒）')), ms);
            }),
        ]);
    }

    async _ensureEditor() {
        if (this.editor) return;
        if (!this.server) throw new Error('云识别未配置');
        if (this._editorFailed) throw new Error('云识别初始化失败：' + this._editorFailed);

        await this._withTimeout(this._loadSDK(), 12000);

        // 隐藏容器：INTERACTIVEINKSSR 服务端渲染，无需可见画布
        let container = document.getElementById('myscript-editor-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'myscript-editor-container';
            container.style.cssText =
                'position:fixed;left:-10000px;top:-10000px;width:800px;height:400px;' +
                'opacity:0;pointer-events:none;z-index:-1;';
            document.body.appendChild(container);
        }

        const options = {
            configuration: {
                server: {
                    scheme: this.server.scheme,
                    host: this.server.host,
                    applicationKey: this.server.applicationKey,
                    hmacKey: this.server.hmacKey,
                },
                recognition: {
                    type: 'MATH',
                    math: {
                        mimeTypes: ['application/x-latex', 'application/vnd.myscript.jiix'],
                    },
                },
            },
        };

        try {
            this.editor = await this._withTimeout(
                window.iink.Editor.load(container, 'INTERACTIVEINKSSR', options),
                15000
            );
            if (this.editor && this.editor.resize) this.editor.resize();
            this._notifyStatus();
        } catch (e) {
            this.editor = null;
            const msg = (e && e.message) ? e.message : String(e);
            // 缓存失败原因，避免每次识别都重复等待 15 秒
            this._editorFailed = msg;
            throw new Error('云识别初始化失败：' + msg);
        }
    }

    /* ================= 识别入口 ================= */

    /**
     * 识别手写笔画（串行排队）
     * @param {Array<Array<{x,y}>>} strokes
     * @param {{numeric?: boolean}} opts
     * @returns {Promise<{expression, confidence, latex, source}|null>}
     */
    recognize(strokes, opts = {}) {
        const run = async () => {
            await this._ensureEditor();
            const latex = await this._recognizeInternal(strokes);
            if (!latex) return null;

            let expression = this._latexToMathjs(latex);
            if (!expression) return null;

            if (opts.numeric) {
                expression = this._numericClean(expression);
            }
            if (!expression) return null;

            console.log('[CloudRecognizer] 云端 LaTeX:', JSON.stringify(latex),
                '→ 转换后:', JSON.stringify(expression));

            return {
                expression,
                confidence: 0.95,
                latex,
                source: 'cloud',
            };
        };

        const result = this._queue.then(run);
        // 无论成功失败都让队列继续
        this._queue = result.then(() => {}, () => {});
        return result;
    }

    /**
     * 单次识别：先清空编辑器 → 再监听 → 导入笔画 → 等待 exported 事件
     * （先 clear 再挂监听，避免 clear 触发的事件干扰结果）
     */
    async _recognizeInternal(strokes) {
        const editor = this.editor;
        if (!editor) throw new Error('编辑器未就绪');

        // 先清空，确保上一次内容不残留
        try {
            await editor.clear();
        } catch (e) {
            console.warn('[CloudRecognizer] clear 异常（继续尝试）:', e);
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(new Error('云识别超时'));
            }, 20000);

            const handler = (evt) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const detail = evt.detail || {};
                const latex = detail['application/x-latex'] || null;
                console.log('[CloudRecognizer] 云端原始 LaTeX:', JSON.stringify(latex));
                resolve(latex);
            };

            editor.event.addEventListener('exported', handler);

            const events = this._buildPointerEvents(strokes);
            editor.importPointEvents(events).catch((e) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                editor.event.removeEventListener('exported', handler);
                reject(e);
            });
        });
    }

    /**
     * 将我的笔画（{x,y} 点序列）转换为 MyScript 的 pointerEvents 结构。
     * 关键点：
     *   1. 坐标归一化到 1000×1000 虚拟空间（保持宽高比、居中）
     *   2. 时间戳为递增的真实毫秒数（间隔 ~25ms），符合 MyScript 时序要求
     */
    _buildPointerEvents(strokes) {
        if (!strokes || strokes.length === 0) return [];

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
        const scale = 800 / Math.max(w, h);
        const offX = (1000 - w * scale) / 2;
        const offY = (1000 - h * scale) / 2;

        let tCounter = 1000000;
        return strokes.map((stroke, i) => {
            const pointerEvents = stroke.map((p) => {
                const t = tCounter;
                tCounter += 25;
                return {
                    x: (p.x - minX) * scale + offX,
                    y: (p.y - minY) * scale + offY,
                    t,
                    p: 1,
                };
            });
            return { type: 'stroke', id: 'stroke-' + i, pointerEvents };
        });
    }

    /**
     * 测试云连接：发送一组内置样本笔画（字母 x），返回云端原始 LaTeX
     */
    async test() {
        if (!this.isConfigured()) return { ok: false, message: '未配置云识别' };
        try {
            const strokes = [
                [{ x: 220, y: 180 }, { x: 300, y: 260 }, { x: 380, y: 340 }],
                [{ x: 380, y: 180 }, { x: 300, y: 260 }, { x: 220, y: 340 }],
            ];
            const res = await this.recognize(strokes);
            const ok = !!(res && res.latex);
            this.verified = ok;
            this._notifyStatus();
            return {
                ok,
                expression: res ? res.expression : null,
                latex: res ? res.latex : null,
            };
        } catch (e) {
            console.error('[CloudRecognizer] 测试失败:', e);
            this.verified = false;
            this._notifyStatus();
            return { ok: false, message: e.message || String(e) };
        }
    }

    /* ================= LaTeX → mathjs ================= */

    _latexToMathjs(latex) {
        let s = (latex || '').trim();
        if (!s) return '';

        // 去掉积分算子（如果用户画了 ∫，我们只取被积函数）
        s = s.replace(/\\int\s*(_{[^}]*})?\s*(\^{[^}]*})?/g, '');
        // 去掉结尾微分尾巴 \,dx 或 dx
        s = s.replace(/\s*\\,\s*d\s*[a-zA-Z]\s*$/g, '');
        s = s.replace(/\s*d\s*[a-zA-Z]\s*$/g, '');

        // 函数名
        s = s.replace(/\\operatorname\{(\w+)\}/g, '$1');
        s = s.replace(/\\mathrm\{(\w+)\}/g, '$1');
        s = s.replace(/\\(sin|cos|tan|log|ln|exp|abs|arctan|arcsin|arccos)\b/g, '$1');
        s = s.replace(/\\log\s*_{[^}]*}/g, 'log'); // log 下标（如 log_10）暂时忽略
        s = s.replace(/\\pi/g, 'pi');
        s = s.replace(/\\sqrt/g, 'sqrt');
        s = s.replace(/\\cdot|\\times|\\ast|\\bullet/g, '*');
        s = s.replace(/\\left|\\right/g, '');
        s = s.replace(/\\vert|\\lvert|\\rvert/g, '|');
        s = s.replace(/\\,/g, '');

        // 分数与根式（循环处理嵌套）
        for (let i = 0; i < 5; i++) {
            const before = s;
            s = s.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
            s = s.replace(/\\sqrt\s*\{([^{}]*)\}/g, 'sqrt($1)');
            if (s === before) break;
        }

        // 上标
        s = s.replace(/\^\{([^{}]*)\}/g, '^$1');

        // 绝对值 |x| → abs(x)
        s = s.replace(/\|([^|]+)\|/g, 'abs($1)');

        // 剩余花括号分组 → 圆括号
        s = s.replace(/\{([^{}]*)\}/g, '($1)');

        // 清理
        s = s.replace(/[ \t\r\n]+/g, '');
        s = s.replace(/\^{}/g, '');
        s = s.replace(/\*\*/g, '*');
        s = s.replace(/\)\s*\(/g, ')*(');

        return s;
    }

    /**
     * 数字模式清洗（积分上下限）：只保留数字/小数点/运算符/pi/e
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
window.CloudRecognizer = CloudRecognizer;
