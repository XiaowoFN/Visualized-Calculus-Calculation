/**
 * Integrator — 一重定积分计算引擎
 *
 * 方法：
 *   1. 使用 math.js 解析表达式并编译为高效 JS 函数
 *   2. 自适应 Simpson 数值积分（主算法）
 *   3. 端点奇异性检测与警告
 *   4. 结果格式化输出
 */
class Integrator {

    constructor() {
        this.defaultTolerance = 1e-10;
        this.maxDepth = 22;
        this.minSubintervals = 8;
    }

    /**
     * Compute definite integral ∫[a,b] f(x) dx
     * @param {string} exprStr  - expression string e.g. "sin(x)"
     * @param {string} variable - integration variable, e.g. "x"
     * @param {number} lower    - lower limit
     * @param {number} upper    - upper limit
     * @returns {{value: number|null, error: string|null, evaluations: number, timeMs: number, formula: string}}
     */
    integrate(exprStr, variable, lower, upper) {
        const t0 = performance.now();

        // ---- Parse expression ----
        let node, compiled;
        try {
            node = math.parse(exprStr);
            compiled = node.compile();
        } catch (e) {
            return this._errorResult('表达式语法错误：' + e.message, t0);
        }

        // ---- Create evaluation function ----
        const scope = {};
        const f = (val) => {
            scope[variable] = val;
            try {
                const result = compiled.evaluate(scope);
                if (typeof result === 'number') return result;
                if (result && typeof result.valueOf === 'function') {
                    const v = result.valueOf();
                    return typeof v === 'number' ? v : NaN;
                }
                return NaN;
            } catch (e) {
                return NaN;
            }
        };

        // ---- Check for singularities at sample points ----
        const singularityMsg = this._detectSingularity(f, lower, upper, variable);

        // ---- Adaptive Simpson integration ----
        let evals = 0;
        const wrappedF = (x) => { evals++; return f(x); };

        let value;
        try {
            value = this._adaptiveSimpson(wrappedF, lower, upper, this.defaultTolerance, this.maxDepth);
        } catch (e) {
            return this._errorResult('积分计算异常：' + e.message, t0);
        }

        const timeMs = Math.round((performance.now() - t0) * 100) / 100;

        if (!isFinite(value)) {
            return this._errorResult(
                '积分不收敛或结果无穷大。请检查被积函数在积分区间 [' +
                lower + ', ' + upper + '] 内是否存在奇点。' +
                (singularityMsg ? ' ' + singularityMsg : ''),
                t0
            );
        }

        // ---- Format result ----
        const formulaTeX = this._formatIntegralTeX(exprStr, variable, lower, upper);

        return {
            value: value,
            error: singularityMsg, // null if no singularity
            evaluations: evals,
            timeMs: timeMs,
            formula: formulaTeX,
            formattedValue: this._formatNumber(value),
        };
    }

    /* ---- Adaptive Simpson's Rule ---- */

    _adaptiveSimpson(f, a, b, tol, maxDepth) {
        // Initial evaluations
        const fa = f(a);
        const fb = f(b);
        const m = (a + b) / 2;
        const fm = f(m);

        const h = b - a;
        const S = (h / 6) * (fa + 4 * fm + fb);

        return this._adaptiveSimpsonRecur(f, a, b, tol, S, fa, fb, fm, maxDepth);
    }

    _adaptiveSimpsonRecur(f, a, b, tol, S, fa, fb, fm, depth) {
        const m = (a + b) / 2;
        const h = b - a;

        const ml = (a + m) / 2;
        const mr = (m + b) / 2;

        const fml = f(ml);
        const fmr = f(mr);

        const h2 = h / 2;
        const Sleft  = (h2 / 6) * (fa + 4 * fml + fm);
        const Sright = (h2 / 6) * (fm + 4 * fmr + fb);
        const S2 = Sleft + Sright;

        if (depth <= 0) {
            // Max depth reached; return with Richardson extrapolation
            return S2 + (S2 - S) / 15;
        }

        // Error estimate
        const error = Math.abs(S2 - S) / 15;

        if (error < tol) {
            // Converged — return with error correction
            return S2 + (S2 - S) / 15;
        }

        // Recurse
        return this._adaptiveSimpsonRecur(f, a, m, tol / 2, Sleft, fa, fm, fml, depth - 1) +
               this._adaptiveSimpsonRecur(f, m, b, tol / 2, Sright, fm, fb, fmr, depth - 1);
    }

    /* ---- Singularity Detection ---- */

    _detectSingularity(f, a, b, variable) {
        const testPoints = [];
        const n = 21;
        for (let i = 0; i <= n; i++) {
            testPoints.push(a + (b - a) * i / n);
        }

        const badPoints = [];
        for (const x of testPoints) {
            const y = f(x);
            if (!isFinite(y) || Math.abs(y) > 1e150) {
                badPoints.push(x);
            }
        }

        if (badPoints.length > 0) {
            // Check if the singularity is only at endpoints (which is often OK)
            const atEndpointsOnly = badPoints.every(x =>
                Math.abs(x - a) < 1e-10 || Math.abs(x - b) < 1e-10
            );
            if (atEndpointsOnly) {
                return '⚠️ 被积函数在端点处存在奇异性，积分可能仍收敛。';
            } else {
                return '⚠️ 被积函数在积分区间内存在奇点（x≈' +
                    badPoints.map(x => this._formatNumber(x)).join(', ') +
                    '），积分可能不收敛。';
            }
        }

        return null;
    }

    /* ---- Formatting ---- */

    _formatNumber(num) {
        if (!isFinite(num)) return String(num);
        const abs = Math.abs(num);
        if (abs === 0) return '0';
        if (abs < 1e-14) return '0'; // practically zero
        if (abs < 1e-4 || abs >= 1e12) {
            return num.toExponential(8);
        }
        // Show up to 12 significant digits, trimming trailing zeros
        const s = num.toPrecision(12);
        // Remove trailing zeros after decimal
        return s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
    }

    _formatIntegralTeX(exprStr, variable, lower, upper) {
        // Build LaTeX for the integral
        const fmtNum = (n) => {
            if (Number.isInteger(n)) return String(n);
            return this._formatNumber(n);
        };

        // Escape LaTeX special chars in the expression
        const texExpr = exprStr
            .replace(/\\/g, '\\backslash ')
            .replace(/\*/g, ' \\cdot ')
            .replace(/\^/g, '^{')  // will need closing brace
            .replace(/pi/g, '\\pi');

        // Clean up ^ issues — simple approach
        const safeExpr = exprStr.replace(/\*/g, ' \\! \\cdot \\! ');

        const lowerStr = fmtNum(lower);
        const upperStr = fmtNum(upper);

        return `\\int_{${lowerStr}}^{${upperStr}} ${safeExpr} \\, d${variable}`;
    }

    _errorResult(msg, t0) {
        return {
            value: null,
            error: msg,
            evaluations: 0,
            timeMs: Math.round((performance.now() - t0) * 100) / 100,
            formula: '',
            formattedValue: '',
        };
    }
}

// Export globally
window.Integrator = Integrator;
