/**
 * App — 微积分计算工具主控制器
 *
 * 职责：组件初始化、UI 事件绑定、自动识别调度、积分计算、
 *       结果渲染（KaTeX）、函数绘图、历史记录管理
 */
class IntegralCalculatorApp {

    constructor() {
        // Components
        this.drawer = null;
        this.recognizer = null;
        this.integrator = null;
        this.cloud = null;

        // State
        this.autoRecognizeTimer = null;
        this.autoRecognizeDelay = 1200; // ms after last stroke
        this.history = [];
        this.maxHistory = 20;
        this._engineReady = false;
        this._recognitionSource = 'local';

        // Mini-canvas state (for limits handwriting)
        this.miniDrawers = {};       // { lowerCanvas: CanvasDrawer, upperCanvas: CanvasDrawer }
        this.miniTimers = {};        // { lowerCanvas: timerId, upperCanvas: timerId }

        // DOM refs (populated in init)
        this.els = {};

        this.init();
    }

    /* ============ Initialization ============ */

    init() {
        this._initErrorBanner();
        this._cacheElements();
        this._initComponents();
        this._initEngineStatus();
        this._bindEvents();
        this._loadHistory();
        console.log('📐 微积分计算工具已就绪');
    }

    _initErrorBanner() {
        // 捕获全局错误，显示在页面上，避免“无反应”无从排查
        window.addEventListener('error', (e) => {
            this._showErrorBanner('JS 错误：' + (e.message || e.error || e.type));
        });
        window.addEventListener('unhandledrejection', (e) => {
            const reason = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
            this._showErrorBanner('未处理的异常：' + reason);
        });
    }

    _showErrorBanner(message) {
        let el = document.getElementById('errorBanner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'errorBanner';
            el.style.cssText =
                'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2000;' +
                'background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;border-radius:8px;' +
                'padding:8px 14px;font-size:12px;max-width:90%;box-shadow:0 4px 12px rgba(0,0,0,.15);' +
                'cursor:pointer;word-break:break-all;';
            el.addEventListener('click', () => el.remove());
            document.body.appendChild(el);
        }
        el.textContent = '⚠️ ' + message + '（点击关闭）';
        el.style.display = 'block';
        // 控制台也打一份
        console.error('[ErrorBanner]', message);
    }

    _initEngineStatus() {
        this.recognizer.whenReady().then(() => {
            this._engineReady = true;
            this._updateEngineStatus();
        }).catch(() => {});
        this._updateEngineStatus();
    }

    _updateEngineStatus() {
        const el = this.els.engineStatus;
        if (!el) return;

        if (this.cloud && this.cloud.isConfigured()) {
            if (this.cloud.isVerified()) {
                el.textContent = '☁️ 云识别已启用';
                el.className = 'engine-status ready';
            } else {
                el.textContent = '🧠 本地识别 · 云端待验证';
                el.className = 'engine-status loading';
            }
        } else if (this._engineReady) {
            el.textContent = '🧠 本地识别 · 点击⚙️配置云识别';
            el.className = 'engine-status loading';
        } else {
            el.textContent = '⚙️ 识别引擎加载中…';
            el.className = 'engine-status loading';
        }
    }

    _cacheElements() {
        const ids = [
            'drawCanvas', 'penBtn', 'eraserBtn', 'undoBtn', 'clearBtn',
            'recognizeBtn', 'expressionInput', 'confidenceBadge', 'modeBadge',
            'lowerLimit', 'upperLimit', 'variable', 'calculateBtn',
            'resultDisplay', 'historyList', 'clearHistoryBtn',
            'plotCanvas', 'plotPlaceholder',
            'lowerCanvas', 'upperCanvas',   // mini canvases for limits
            'engineStatus', 'recognitionSource',
            // Cloud settings modal
            'settingsBtn', 'settingsModal', 'cloudAppKey', 'cloudHmacKey',
            'cloudStatus', 'cloudSaveBtn', 'cloudClearBtn', 'cloudCloseBtn',
            'cloudTestBtn', 'cloudLocalTestBtn'
        ];
        for (const id of ids) {
            this.els[id] = document.getElementById(id);
        }
    }

    _initComponents() {
        // Main canvas drawer
        this.drawer = new CanvasDrawer(this.els.drawCanvas);
        this.drawer.onStrokeChange = (strokes) => this._onStrokesChanged(strokes);

        // Mini canvas drawers for limits handwriting
        this._initMiniCanvas('lowerCanvas', 'lowerLimit');
        this._initMiniCanvas('upperCanvas', 'upperLimit');

        // Math recognizer (shared, local fallback)
        this.recognizer = new MathRecognizer();

        // Cloud recognizer (MyScript, primary)
        this.cloud = new CloudRecognizer();
        this.cloud.onStatus(() => this._updateEngineStatus());

        // Integrator
        this.integrator = new Integrator();
    }

    /**
     * Initialize a mini handwriting canvas for a limit input
     * @param {string} canvasId  - canvas element ID
     * @param {string} inputId   - associated text input ID
     */
    _initMiniCanvas(canvasId, inputId) {
        const canvasEl = this.els[canvasId];
        if (!canvasEl) return;

        const drawer = new CanvasDrawer(canvasEl);
        // Override pen width for mini canvas (slightly thinner)
        drawer.penWidth = 2.5;
        this.miniDrawers[canvasId] = drawer;

        // Auto-recognize on stroke change
        drawer.onStrokeChange = (strokes) => {
            if (this.miniTimers[canvasId]) {
                clearTimeout(this.miniTimers[canvasId]);
            }
            if (strokes.length > 0) {
                this.miniTimers[canvasId] = setTimeout(() => {
                    this._recognizeMiniCanvas(canvasId, inputId);
                }, 800); // slightly faster than main canvas
            }
        };
    }

    /**
     * Recognize handwriting on a mini canvas and fill its input
     */
    async _recognizeMiniCanvas(canvasId, inputId) {
        const drawer = this.miniDrawers[canvasId];
        if (!drawer) return;

        const strokes = drawer.getStrokes();
        if (strokes.length === 0) return;

        // 数字模式：输出偏向数字/小数，适合积分上下限
        const result = await this._recognizeStrokes(strokes, { numeric: true });
        if (result && result.expression && result.expression !== '?') {
            // Clean up for limit values: remove common misrecognitions
            let cleaned = result.expression
                .replace(/\?/g, '')           // remove unknowns
                .replace(/[=<>]/g, '')        // remove comparison operators
                .trim();

            if (cleaned) {
                this.els[inputId].value = cleaned;
                this._flashElement(this.els[inputId]);
            }
        }
    }

    /* ============ Event Binding ============ */

    _bindEvents() {
        // Tool buttons
        this.els.penBtn.addEventListener('click', () => this._setTool('pen'));
        this.els.eraserBtn.addEventListener('click', () => this._setTool('eraser'));
        this.els.undoBtn.addEventListener('click', () => this.drawer.undo());
        this.els.clearBtn.addEventListener('click', () => this.drawer.clear());

        // Recognize button
        this.els.recognizeBtn.addEventListener('click', () => this._doRecognize());

        // Calculate button
        this.els.calculateBtn.addEventListener('click', () => this._doCalculate());

        // Enter key in expression input triggers calculation
        this.els.expressionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this._doCalculate();
        });

        // Enter key in limit inputs
        [this.els.lowerLimit, this.els.upperLimit].forEach(el => {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') this._doCalculate();
            });
        });

        // Clear history
        this.els.clearHistoryBtn.addEventListener('click', () => this._clearHistory());

        // Cloud settings modal
        this.els.settingsBtn.addEventListener('click', () => this._openSettings());
        this.els.cloudSaveBtn.addEventListener('click', () => this._saveCloudSettings());
        this.els.cloudClearBtn.addEventListener('click', () => this._clearCloudSettings());
        this.els.cloudCloseBtn.addEventListener('click', () => this._closeSettings());
        this.els.cloudTestBtn.addEventListener('click', () => this._testCloud());
        this.els.cloudLocalTestBtn.addEventListener('click', () => this._testLocal());
        this.els.settingsModal.addEventListener('click', (e) => {
            if (e.target === this.els.settingsModal) this._closeSettings();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this._closeSettings();
        });

        // Mini canvas clear buttons
        document.querySelectorAll('.mini-clear').forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.target;
                if (targetId && this.miniDrawers[targetId]) {
                    this.miniDrawers[targetId].clear();
                    // Also clear the associated input
                    const inputMap = { lowerCanvas: 'lowerLimit', upperCanvas: 'upperLimit' };
                    const inputId = inputMap[targetId];
                    if (inputId && this.els[inputId]) {
                        this.els[inputId].value = '';
                    }
                }
            });
        });

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                this._doCalculate();
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                this.drawer.undo();
            }
        });
    }

    /* ============ Tool Management ============ */

    _setTool(mode) {
        this.drawer.setMode(mode);

        // Update button states
        this.els.penBtn.classList.toggle('active', mode === 'pen');
        this.els.eraserBtn.classList.toggle('active', mode === 'eraser');

        // Update badge
        this.els.modeBadge.textContent = mode === 'pen' ? '画笔模式' : '橡皮模式';
    }

    /* ============ Cloud Settings ============ */

    _openSettings() {
        if (this.cloud.server) {
            this.els.cloudAppKey.value = this.cloud.server.applicationKey || '';
            this.els.cloudHmacKey.value = this.cloud.server.hmacKey || '';
        } else {
            this.els.cloudAppKey.value = '';
            this.els.cloudHmacKey.value = '';
        }
        this._updateCloudStatusText();
        this.els.settingsModal.classList.remove('hidden');
    }

    _closeSettings() {
        this.els.settingsModal.classList.add('hidden');
    }

    _saveCloudSettings() {
        const appKey = this.els.cloudAppKey.value.trim();
        const hmacKey = this.els.cloudHmacKey.value.trim();
        if (!appKey || !hmacKey) {
            this.els.cloudStatus.textContent = '⚠️ 请填写 Application Key 和 HMAC Key';
            return;
        }
        this.cloud.saveServer({ applicationKey: appKey, hmacKey });
        this._updateCloudStatusText();
        this._updateEngineStatus();
        this._closeSettings();
    }

    _clearCloudSettings() {
        this.cloud.clearServer();
        this._updateCloudStatusText();
        this._updateEngineStatus();
    }

    _updateCloudStatusText() {
        const el = this.els.cloudStatus;
        if (!el) return;
        if (this.cloud.server) {
            el.textContent = '✓ 已保存云端密钥，可开始云识别（免费版有月度额度，超额可手动编辑）';
            el.className = 'modal-status ok';
        } else {
            el.textContent = '未配置云识别，当前使用本地识别';
            el.className = 'modal-status warn';
        }
    }

    async _testCloud() {
        const statusEl = this.els.cloudStatus;
        if (!statusEl) return;
        if (!this.cloud.isConfigured()) {
            statusEl.textContent = '⚠️ 请先保存云识别 Key';
            statusEl.className = 'modal-status warn';
            return;
        }
        statusEl.textContent = '☁️ 测试中…（最多18秒，会自动结束）';
        statusEl.className = 'modal-status warn';

        // 秒数倒计时，让用户看到进度
        const start = Date.now();
        const elapsedTimer = setInterval(() => {
            const s = Math.round((Date.now() - start) / 1000);
            statusEl.textContent = `☁️ 测试中…（已等待 ${s} 秒，最多18秒）`;
        }, 1000);

        try {
            const res = await this._withTimeout(this.cloud.test(), 18000);
            clearInterval(elapsedTimer);
            if (res && res.ok && res.latex) {
                statusEl.textContent = '✓ 云识别正常！返回 LaTeX: ' + res.latex;
                statusEl.className = 'modal-status ok';
            } else {
                const reason = res && res.message ? res.message : '云端未返回内容';
                statusEl.textContent = '✗ 云识别异常：' + reason + '（当前仍使用本地识别）';
                statusEl.className = 'modal-status warn';
            }
        } catch (e) {
            clearInterval(elapsedTimer);
            statusEl.textContent = '✗ 测试超时/失败：' + (e.message || String(e)) + '（当前仍使用本地识别）';
            statusEl.className = 'modal-status warn';
        }
        this._updateEngineStatus();
    }

    /**
     * 本地识别诊断：发送一个"数字1"样本，看本地引擎是否正常
     */
    _testLocal() {
        const statusEl = this.els.cloudStatus;
        if (!statusEl) return;

        const strokes = [
            Array.from({ length: 20 }, (_, i) => ({ x: 100 + i * 0.5, y: 50 + i * 5 })),
        ];
        const protos = (this.recognizer.prototypes && this.recognizer.prototypes.length) || 0;
        const res = this.recognizer.recognize(strokes);
        statusEl.textContent =
            `本地识别测试：写"1" → 识别为 "${res.expression || '（空）'}"` +
            ` · 原型库 ${protos} 个`;
        statusEl.className = 'modal-status ok';
    }

    /* ============ Auto-Recognition ============ */

    _onStrokesChanged(strokes) {
        // Debounced auto-recognition
        if (this.autoRecognizeTimer) {
            clearTimeout(this.autoRecognizeTimer);
        }
        if (strokes.length > 0) {
            this.autoRecognizeTimer = setTimeout(() => {
                this._doRecognize();
            }, this.autoRecognizeDelay);
        } else {
            // Canvas cleared
            this.els.expressionInput.value = '';
            this._setConfidence(null);
        }
    }

    /* ============ Recognition ============ */

    /**
     * 给 Promise 加超时，防止云识别挂起导致界面卡死
     */
    _withTimeout(promise, ms) {
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('超时（' + Math.round(ms / 1000) + '秒）')), ms);
            }),
        ]);
    }

    /**
     * 识别入口：
     *   - 云识别仅当「已配置 且 已通过测试验证」时才使用，且带超时
     *   - 否则一律走本地识别（立刻返回，不会卡住）
     */
    async _recognizeStrokes(strokes, opts) {
        if (this.cloud && this.cloud.isConfigured() && this.cloud.isVerified()) {
            this._setConfidence(null); // 显示等待
            try {
                const res = await this._withTimeout(this.cloud.recognize(strokes, opts), 16000);
                if (res && res.expression) return res;
            } catch (e) {
                console.warn('[CloudRecognizer] 识别失败，回退本地识别:', e);
            }
        }
        const res = this.recognizer.recognize(strokes, opts);
        return { ...res, source: 'local' };
    }

    async _doRecognize() {
        const strokes = this.drawer.getStrokes();
        if (strokes.length === 0) {
            this._flashElement(this.els.drawCanvas);
            return;
        }

        const result = await this._recognizeStrokes(strokes);

        if (result && result.expression) {
            this.els.expressionInput.value = result.expression;
            this._setConfidence(result.confidence);
            this._setRecognitionSource(result.source || 'local');
            // Trigger a subtle highlight on the input
            this._flashElement(this.els.expressionInput);
        } else {
            this._setConfidence(0);
            this._setRecognitionSource('local');
        }
    }

    _setRecognitionSource(source) {
        const el = this.els.recognitionSource;
        if (!el) return;
        if (source === 'cloud') {
            el.textContent = '☁️ 云端识别';
            el.className = 'recognition-source cloud';
        } else {
            el.textContent = '🧠 本地识别';
            el.className = 'recognition-source local';
        }
    }

    _setConfidence(confidence) {
        const badge = this.els.confidenceBadge;
        if (confidence === null || confidence === undefined) {
            badge.classList.add('hidden');
            return;
        }
        badge.classList.remove('hidden');
        badge.classList.remove('high', 'medium', 'low');

        const pct = Math.round(confidence * 100);
        if (confidence >= 0.7) {
            badge.classList.add('high');
            badge.textContent = `✓ 置信度 ${pct}%`;
        } else if (confidence >= 0.4) {
            badge.classList.add('medium');
            badge.textContent = `△ 置信度 ${pct}%`;
        } else {
            badge.classList.add('low');
            badge.textContent = `✗ 置信度 ${pct}%`;
        }
    }

    /* ============ Calculation ============ */

    _doCalculate() {
        const exprStr = this.els.expressionInput.value.trim();
        if (!exprStr) {
            this._showResultError('请先输入或手写识别被积函数 f(x)。');
            this._flashElement(this.els.expressionInput);
            return;
        }

        const lowerStr = this.els.lowerLimit.value.trim();
        const upperStr = this.els.upperLimit.value.trim();
        const variable = this.els.variable.value.trim() || 'x';

        // Parse limits: they can be expressions themselves (e.g., "pi", "2*pi")
        let lower, upper;
        try {
            lower = this._parseNumber(lowerStr);
            upper = this._parseNumber(upperStr);
        } catch (e) {
            this._showResultError('积分上下限格式错误：' + e.message);
            return;
        }

        if (isNaN(lower) || isNaN(upper)) {
            this._showResultError('积分上下限必须为有效数值。');
            return;
        }

        if (lower === upper) {
            this._showResultError('积分上下限相同，结果为零。请修改上下限。');
            return;
        }

        // Show loading state
        this._setCalculating(true);

        // Use setTimeout to allow UI to update before computation
        setTimeout(() => {
            const result = this.integrator.integrate(exprStr, variable, lower, upper);
            this._displayResult(result, exprStr, variable, lower, upper);
            this._setCalculating(false);

            if (result.value !== null) {
                this._drawPlot(exprStr, variable, lower, upper, result.value);
                this._addToHistory(exprStr, variable, lower, upper, result);
            } else {
                this._hidePlot();
            }
        }, 50);
    }

    _parseNumber(str) {
        if (!str || str.trim() === '') return NaN;
        // Allow math constants using math.js
        try {
            const result = math.evaluate(str.trim());
            if (typeof result === 'number') return result;
            if (result && typeof result.valueOf === 'function') {
                const v = result.valueOf();
                return typeof v === 'number' ? v : NaN;
            }
            return NaN;
        } catch (e) {
            return NaN;
        }
    }

    _setCalculating(loading) {
        const btn = this.els.calculateBtn;
        if (loading) {
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner"></span> 正在计算...';
        } else {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📊</span><span class="btn-text">计算定积分</span><span class="btn-formula">∫<sub>a</sub><sup>b</sup> f(x) dx</span>';
        }
    }

    /* ============ Result Display ============ */

    _displayResult(result, exprStr, variable, lower, upper) {
        const container = this.els.resultDisplay;

        if (result.error && result.value === null) {
            this._showResultError(result.error);
            return;
        }

        // Build TeX display
        const fmtNum = (n) => {
            if (!isFinite(n)) return String(n);
            if (Number.isInteger(n) || (typeof n === 'number' && n === Math.floor(n) && Math.abs(n) < 1e12)) {
                return String(Math.floor(n));
            }
            const s = Number(n).toPrecision(10);
            return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
        };

        const lowerStr = fmtNum(lower);
        const upperStr = fmtNum(upper);

        // Escape expression for LaTeX
        const texExpr = exprStr
            .replace(/\\/g, '\\backslash ')
            .replace(/\*/g, ' \\!\\cdot\\! ')
            .replace(/pi/g, '\\pi');

        const integralTeX = `\\int_{${lowerStr}}^{${upperStr}} ${texExpr} \\, d${variable}`;
        const resultTeX = integralTeX + ' = ' + (result.formattedValue || fmtNum(result.value));

        let html = '<div class="result-content">';

        // Integral formula
        html += '<div class="result-formula" id="resultFormula"></div>';

        // Numerical result
        html += '<div class="result-value">= ' + (result.formattedValue || fmtNum(result.value)) + '</div>';

        // Meta info
        html += '<div class="result-details">';
        html += '函数求值 ' + result.evaluations + ' 次 · ';
        html += '耗时 ' + result.timeMs + ' ms · ';
        html += '自适应 Simpson 算法';
        if (result.error) {
            html += '<br><span style="color:#f59e0b">' + result.error + '</span>';
        }
        html += '</div>';

        html += '</div>';

        container.innerHTML = html;

        // Render LaTeX with KaTeX
        const formulaEl = document.getElementById('resultFormula');
        if (formulaEl && window.katex) {
            try {
                katex.render(resultTeX, formulaEl, {
                    throwOnError: false,
                    displayMode: true,
                    trust: true,
                });
            } catch (e) {
                formulaEl.textContent = resultTeX;
            }
        }
    }

    _showResultError(message) {
        const container = this.els.resultDisplay;
        container.innerHTML = `
            <div class="result-error">
                <strong>⚠️ 计算出错</strong>
                ${message}
            </div>
        `;
    }

    /* ============ Function Plot ============ */

    _drawPlot(exprStr, variable, lower, upper, integralValue) {
        const canvas = this.els.plotCanvas;
        const placeholder = this.els.plotPlaceholder;

        if (!canvas) return;

        // Parse the function
        let compiled;
        try {
            const node = math.parse(exprStr);
            compiled = node.compile();
        } catch (e) {
            this._hidePlot();
            return;
        }

        const f = (x) => {
            const scope = {};
            scope[variable] = x;
            try {
                const r = compiled.evaluate(scope);
                return (typeof r === 'number') ? r : NaN;
            } catch (e) {
                return NaN;
            }
        };

        // Set up canvas
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.parentElement.getBoundingClientRect();
        const W = rect.width - 16;
        const H = 260;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        canvas.width = W * dpr;
        canvas.height = H * dpr;

        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);

        // Compute plot range: incorporate the integration limits with padding
        const range = Math.abs(upper - lower);
        const padding = Math.max(range * 0.3, 0.5);
        let xMin = Math.min(lower, upper) - padding;
        let xMax = Math.max(lower, upper) + padding;

        // Make sure 0 is visible
        if (xMin > 0) xMin = -padding * 0.5;
        if (xMax < 0) xMax = padding * 0.5;

        // Sample function to find y range
        const samples = 200;
        let yMin = Infinity, yMax = -Infinity;
        const points = [];
        for (let i = 0; i <= samples; i++) {
            const x = xMin + (xMax - xMin) * i / samples;
            const y = f(x);
            if (isFinite(y) && Math.abs(y) < 1e8) {
                if (y < yMin) yMin = y;
                if (y > yMax) yMax = y;
                points.push({ x, y });
            } else {
                points.push({ x, y: NaN });
            }
        }

        if (!isFinite(yMin) || !isFinite(yMax)) {
            this._hidePlot();
            return;
        }

        const yPadding = Math.max((yMax - yMin) * 0.2, 0.5);
        yMin -= yPadding;
        yMax += yPadding;

        // Make sure 0 is in y range too
        if (yMin > 0) yMin = -yPadding;
        if (yMax < 0) yMax = yPadding;

        // Margins
        const margin = { top: 20, right: 20, bottom: 35, left: 55 };
        const pw = W - margin.left - margin.right;
        const ph = H - margin.top - margin.bottom;

        const toX = (x) => margin.left + (x - xMin) / (xMax - xMin) * pw;
        const toY = (y) => margin.top + (yMax - y) / (yMax - yMin) * ph;

        // ---- Draw axes ----
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 1;
        // x-axis
        if (0 >= yMin && 0 <= yMax) {
            const y0 = toY(0);
            ctx.beginPath();
            ctx.moveTo(margin.left, y0);
            ctx.lineTo(W - margin.right, y0);
            ctx.stroke();
        }
        // y-axis
        if (0 >= xMin && 0 <= xMax) {
            const x0 = toX(0);
            ctx.beginPath();
            ctx.moveTo(x0, margin.top);
            ctx.lineTo(x0, H - margin.bottom);
            ctx.stroke();
        }

        // ---- Draw shaded integration region ----
        const xL = Math.min(lower, upper);
        const xR = Math.max(lower, upper);
        const yZero = toY(0);

        ctx.save();
        ctx.beginPath();
        // Start at (xL, 0)
        ctx.moveTo(toX(xL), yZero);
        // Draw function curve within [xL, xR]
        let firstInRange = true;
        for (const p of points) {
            if (p.x >= xL && p.x <= xR && isFinite(p.y)) {
                if (firstInRange) {
                    ctx.lineTo(toX(p.x), toY(p.y));
                    firstInRange = false;
                } else {
                    ctx.lineTo(toX(p.x), toY(p.y));
                }
            }
        }
        // Back to (xR, 0)
        ctx.lineTo(toX(xR), yZero);
        ctx.closePath();
        ctx.fillStyle = 'rgba(79, 70, 229, 0.12)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(79, 70, 229, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();

        // ---- Draw function curve ----
        ctx.beginPath();
        let started = false;
        for (const p of points) {
            if (isFinite(p.y)) {
                const sx = toX(p.x);
                const sy = toY(p.y);
                if (!started) {
                    ctx.moveTo(sx, sy);
                    started = true;
                } else {
                    ctx.lineTo(sx, sy);
                }
            } else {
                started = false;
            }
        }
        ctx.strokeStyle = '#4f46e5';
        ctx.lineWidth = 2;
        ctx.stroke();

        // ---- Draw integration limits (vertical dashed lines) ----
        ctx.setLineDash([4, 6]);
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;
        [lower, upper].forEach(lim => {
            const x = toX(lim);
            ctx.beginPath();
            ctx.moveTo(x, margin.top);
            ctx.lineTo(x, H - margin.bottom);
            ctx.stroke();
        });
        ctx.setLineDash([]);

        // ---- Axis labels ----
        ctx.fillStyle = '#64748b';
        ctx.font = '11px -apple-system, sans-serif';
        ctx.textAlign = 'center';

        // X-axis ticks
        const xTickCount = 5;
        for (let i = 0; i <= xTickCount; i++) {
            const xVal = xMin + (xMax - xMin) * i / xTickCount;
            const x = toX(xVal);
            const label = this._tickFormat(xVal);
            ctx.fillText(label, x, H - margin.bottom + 15);
        }

        // Y-axis ticks
        ctx.textAlign = 'right';
        const yTickCount = 5;
        for (let i = 0; i <= yTickCount; i++) {
            const yVal = yMin + (yMax - yMin) * i / yTickCount;
            const y = toY(yVal);
            const label = this._tickFormat(yVal);
            ctx.fillText(label, margin.left - 8, y + 4);
        }

        // ---- Title ----
        ctx.fillStyle = '#1e293b';
        ctx.font = 'bold 12px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        const areaText = '∫ f(x)dx ≈ ' + (integralValue !== null ?
            (Math.abs(integralValue) < 1e-8 ? '0' :
             Math.abs(integralValue) < 0.01 || Math.abs(integralValue) > 9999 ?
             integralValue.toExponential(4) : integralValue.toFixed(6)) : '?');
        ctx.fillText('阴影区域 = 积分值 ≈ ' + areaText, W / 2, margin.top - 4);

        // Show canvas, hide placeholder
        canvas.style.display = 'block';
        if (placeholder) placeholder.style.display = 'none';
    }

    _tickFormat(val) {
        const abs = Math.abs(val);
        if (abs === 0) return '0';
        if (abs < 0.01 || abs >= 10000) return val.toExponential(1);
        if (abs >= 1) return val.toFixed(1).replace(/\.0$/, '');
        return val.toFixed(2);
    }

    _hidePlot() {
        if (this.els.plotCanvas) this.els.plotCanvas.style.display = 'none';
        if (this.els.plotPlaceholder) this.els.plotPlaceholder.style.display = '';
    }

    /* ============ History ============ */

    _addToHistory(exprStr, variable, lower, upper, result) {
        const entry = {
            expr: exprStr,
            variable: variable,
            lower: lower,
            upper: upper,
            value: result.value,
            formattedValue: result.formattedValue,
            time: new Date().toISOString(),
        };

        this.history.unshift(entry);
        if (this.history.length > this.maxHistory) {
            this.history.pop();
        }

        this._renderHistory();
        this._saveHistory();
    }

    _renderHistory() {
        const container = this.els.historyList;
        if (this.history.length === 0) {
            container.innerHTML = '<p class="placeholder-text">暂无历史记录</p>';
            return;
        }

        let html = '';
        for (let i = 0; i < this.history.length; i++) {
            const h = this.history[i];
            const valStr = h.formattedValue || (h.value !== null ? this._fmtShort(h.value) : '?');
            const timeStr = new Date(h.time).toLocaleString('zh-CN', {
                month: 'numeric', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            html += `
                <div class="history-item" data-index="${i}" title="点击回填">
                    <span class="hi-formula">∫<sub>${this._fmtShort(h.lower)}</sub><sup>${this._fmtShort(h.upper)}</sup> ${h.expr} d${h.variable}</span>
                    <span class="hi-result">= ${valStr}</span>
                    <span style="font-size:0.7rem;color:#94a3b8;margin-left:6px">${timeStr}</span>
                    <button class="hi-delete" data-index="${i}" title="删除">×</button>
                </div>`;
        }
        container.innerHTML = html;

        // Bind click to restore
        container.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('hi-delete')) return;
                const idx = parseInt(item.dataset.index);
                this._restoreFromHistory(idx);
            });
        });

        // Bind delete buttons
        container.querySelectorAll('.hi-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.index);
                this._deleteHistoryItem(idx);
            });
        });
    }

    _restoreFromHistory(index) {
        const entry = this.history[index];
        if (!entry) return;
        this.els.expressionInput.value = entry.expr;
        this.els.lowerLimit.value = entry.lower;
        this.els.upperLimit.value = entry.upper;
        this.els.variable.value = entry.variable;
        // Auto-calculate
        this._doCalculate();
    }

    _deleteHistoryItem(index) {
        this.history.splice(index, 1);
        this._renderHistory();
        this._saveHistory();
    }

    _clearHistory() {
        this.history = [];
        this._renderHistory();
        this._saveHistory();
    }

    _saveHistory() {
        try {
            localStorage.setItem('integral_calc_history', JSON.stringify(this.history));
        } catch (e) {
            // localStorage might be full or unavailable
        }
    }

    _loadHistory() {
        try {
            const raw = localStorage.getItem('integral_calc_history');
            if (raw) {
                this.history = JSON.parse(raw);
                this._renderHistory();
            }
        } catch (e) {
            this.history = [];
        }
    }

    _fmtShort(num) {
        if (!isFinite(num)) return String(num);
        const abs = Math.abs(num);
        if (abs === 0) return '0';
        if (abs < 0.01 || abs > 99999) return num.toExponential(3);
        return Number(num.toPrecision(8)).toString();
    }

    /* ============ Helpers ============ */

    _flashElement(el) {
        if (!el) return;
        el.style.transition = 'none';
        el.style.boxShadow = '0 0 0 3px rgba(79,70,229,0.4)';
        setTimeout(() => {
            el.style.transition = 'box-shadow 0.5s ease';
            el.style.boxShadow = '';
        }, 150);
    }
}

/* ============ Bootstrap ============ */

document.addEventListener('DOMContentLoaded', () => {
    window.app = new IntegralCalculatorApp();
});
