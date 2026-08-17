/**
 * CanvasDrawer — 手写画布管理器
 *
 * 功能：流畅画笔/橡皮绘制、撤销、清屏、网格背景、高 DPI 适配、触摸支持
 * 输出：structured stroke data for recognition
 */
class CanvasDrawer {

    constructor(canvasEl) {
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext('2d');

        // Stroke storage
        /** @type {Array<Array<{x:number,y:number}>>} */
        this.strokes = [];
        /** @type {Array<{x:number,y:number}>|null} */
        this.currentStroke = null;
        /** @type {'pen'|'eraser'} */
        this.mode = 'pen';

        // State
        this.isDrawing = false;
        this.width = 0;
        this.height = 0;
        this.dpr = 1;

        // Rendering config
        this.penColor = '#1e293b';
        this.penWidth = 3.0;
        this.eraserRadius = 18;
        this.gridColor = '#e8ecf1';
        this.gridSpacing = 25;

        // Callbacks
        this.onStrokeChange = null;

        this._resize();
        this._bindEvents();
        this._drawGrid();
    }

    /* ---- Size management ---- */

    _resize() {
        const rect = this.canvas.getBoundingClientRect();
        this.dpr = window.devicePixelRatio || 1;
        this.width = rect.width;
        this.height = rect.height;
        this.canvas.width = rect.width * this.dpr;
        this.canvas.height = rect.height * this.dpr;
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    /* ---- Grid background ---- */

    _drawGrid() {
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.fillStyle = this.gridColor;
        for (let x = this.gridSpacing; x < this.width; x += this.gridSpacing) {
            for (let y = this.gridSpacing; y < this.height; y += this.gridSpacing) {
                ctx.beginPath();
                ctx.arc(x, y, 1.0, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        // subtle center line
        ctx.strokeStyle = '#e0e4ea';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([6, 14]);
        ctx.beginPath();
        ctx.moveTo(0, this.height / 2);
        ctx.lineTo(this.width, this.height / 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    /* ---- Full redraw ---- */

    redraw() {
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.restore();
        this._drawGrid();
        this._renderAllStrokes();
    }

    _renderAllStrokes() {
        for (const stroke of this.strokes) {
            this._renderStroke(stroke);
        }
        if (this.currentStroke && this.currentStroke.length > 0) {
            this._renderStroke(this.currentStroke);
        }
    }

    /* ---- Render a single stroke ---- */

    _renderStroke(points) {
        if (points.length === 0) return;
        const ctx = this.ctx;
        ctx.save();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (points.length === 1) {
            // single dot
            ctx.fillStyle = this.penColor;
            ctx.beginPath();
            ctx.arc(points[0].x, points[0].y, this.penWidth / 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.strokeStyle = this.penColor;
            ctx.lineWidth = this.penWidth;
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);

            if (points.length === 2) {
                ctx.lineTo(points[1].x, points[1].y);
            } else {
                // Quadratic bezier through midpoints for smooth curves
                for (let i = 0; i < points.length - 1; i++) {
                    const midX = (points[i].x + points[i + 1].x) / 2;
                    const midY = (points[i].y + points[i + 1].y) / 2;
                    ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
                }
                // final segment
                const last = points[points.length - 1];
                ctx.lineTo(last.x, last.y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    /* ---- Event binding (Pointer Events unify mouse + touch + pen) ---- */

    _bindEvents() {
        this.canvas.addEventListener('pointerdown', this._onPointerDown.bind(this));
        this.canvas.addEventListener('pointermove', this._onPointerMove.bind(this));
        this.canvas.addEventListener('pointerup', this._onPointerUp.bind(this));
        this.canvas.addEventListener('pointerleave', this._onPointerUp.bind(this));
        this.canvas.addEventListener('pointercancel', this._onPointerUp.bind(this));
        // Prevent context menu on long-press (touch)
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    _getCanvasPos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
    }

    _onPointerDown(e) {
        this.canvas.setPointerCapture(e.pointerId);
        this.isDrawing = true;
        const pos = this._getCanvasPos(e);
        this.currentStroke = [pos];

        if (this.mode === 'eraser') {
            // Eraser starts erasing immediately
            this._eraseAtPoint(pos);
        }
    }

    _onPointerMove(e) {
        if (!this.isDrawing) return;
        const pos = this._getCanvasPos(e);

        if (this.mode === 'pen') {
            this.currentStroke.push(pos);
            // redraw only the current stroke cheaply: redraw all
            this.redraw();
        } else {
            // eraser mode
            this.currentStroke.push(pos);
            this._eraseAtPoint(pos);
        }
    }

    _onPointerUp(e) {
        if (!this.isDrawing) return;
        this.isDrawing = false;

        if (this.mode === 'pen' && this.currentStroke && this.currentStroke.length > 0) {
            this.strokes.push([...this.currentStroke]);
        }
        // For eraser, the erase strokes are just tracking paths — discard after use
        this.currentStroke = null;
        this.redraw();

        if (this.onStrokeChange) {
            this.onStrokeChange(this.strokes);
        }
    }

    /* ---- Eraser logic ---- */

    _eraseAtPoint(pos) {
        // Remove strokes that intersect with eraser circle at pos
        const r2 = this.eraserRadius * this.eraserRadius;
        let removed = false;

        this.strokes = this.strokes.filter(stroke => {
            const hit = stroke.some(p => {
                const dx = p.x - pos.x;
                const dy = p.y - pos.y;
                return (dx * dx + dy * dy) <= r2;
            });
            if (hit) removed = true;
            return !hit;
        });

        if (removed) {
            this.redraw();
            if (this.onStrokeChange) {
                this.onStrokeChange(this.strokes);
            }
        }
    }

    /* ---- Public API ---- */

    setMode(mode) {
        this.mode = mode;
        if (mode === 'eraser') {
            this.canvas.classList.add('eraser-mode');
        } else {
            this.canvas.classList.remove('eraser-mode');
        }
    }

    undo() {
        if (this.strokes.length > 0) {
            this.strokes.pop();
            this.redraw();
            if (this.onStrokeChange) {
                this.onStrokeChange(this.strokes);
            }
        }
    }

    clear() {
        this.strokes = [];
        this.currentStroke = null;
        this.redraw();
        if (this.onStrokeChange) {
            this.onStrokeChange(this.strokes);
        }
    }

    /** @returns {Array<Array<{x:number,y:number}>>} */
    getStrokes() {
        return this.strokes;
    }

    hasStrokes() {
        return this.strokes.length > 0;
    }
}

// Export globally
window.CanvasDrawer = CanvasDrawer;
