/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Optional DOM related utilities. Some utilities, useful to decode QR from camera:
 * - draw overlay: helps user to position QR code on camera
 * - draw result: show scanned QR code
 * The code is fragile: it is easy to make subtle errors, which will break decoding.
 * @module
 */
import { _QRScanner, } from './decode.js';
const Y8 = [0, 0, 1];
const UV8 = [1, 1, 1];
const P420 = [Y8, UV8, UV8];
const P420_16 = [
    [0, 0, 2],
    [1, 1, 2],
    [1, 1, 2],
];
const P_RGBA = [[0, 0, 4]];
const PLANES = {
    RGB: [[0, 0, 3]],
    RGBA: P_RGBA,
    RGBX: P_RGBA,
    BGRA: P_RGBA,
    BGRX: P_RGBA,
    I420: P420,
    I420P10: P420_16,
    I420P12: P420_16,
    I420A: [Y8, UV8, UV8, Y8],
    I422: [Y8, [1, 0, 1], [1, 0, 1]],
    I444: [Y8, Y8, Y8],
    NV12: [Y8, [1, 1, 2]],
};
const framePlanes = (format) => PLANES[format];
/**
 * Read rendered element dimensions from computed CSS.
 * @param elm - Element whose computed width and height should be parsed.
 * @returns Pixel width and height parsed from computed styles.
 * @example
 * Read rendered element dimensions from computed CSS.
 * ```ts
 * import { getSize } from 'qr/dom.js';
 * if (typeof document !== 'undefined') {
 *   const video = document.querySelector('video')!;
 *   void getSize(video);
 * }
 * ```
 */
export const getSize = (elm) => {
    const css = getComputedStyle(elm);
    const width = Math.floor(+css.width.split('px')[0]);
    const height = Math.floor(+css.height.split('px')[0]);
    return { width, height };
};
const setCanvasSize = (canvas, height, width) => {
    // NOTE: setting canvas.width even to same size will clear & redraw it (flickering)
    if (canvas.height !== height)
        canvas.height = height;
    if (canvas.width !== width)
        canvas.width = width;
};
const getCanvasContext = (canvas) => {
    const context = canvas.getContext('2d');
    if (context === null)
        throw new Error('Cannot get canvas context');
    return { canvas, context };
};
const clearCanvas = ({ canvas, context }) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
};
const traceQuad = (context, points) => {
    context.beginPath();
    context.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++)
        context.lineTo(points[i].x, points[i].y);
    context.closePath();
};
const fillQuad = (context, points) => {
    traceQuad(context, points);
    context.fill();
};
const toward = (from, to, distance) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const scale = Math.min(0.5, distance / Math.hypot(dx, dy));
    return { x: from.x + scale * dx, y: from.y + scale * dy };
};
const traceRoundedQuad = (context, points, radius) => {
    const starts = points.map((point, i) => toward(point, points[(i + 1) % 4], radius));
    const ends = points.map((point, i) => toward(point, points[(i + 3) % 4], radius));
    context.beginPath();
    context.moveTo(starts[0].x, starts[0].y);
    for (let i = 1; i <= points.length; i++) {
        const pos = i % 4;
        context.lineTo(ends[pos].x, ends[pos].y);
        context.quadraticCurveTo(points[pos].x, points[pos].y, starts[pos].x, starts[pos].y);
    }
    context.closePath();
};
// Three consecutive frames suppress transient identity changes in camera captures.
const OVERLAY_SWITCH_FRAMES = 3;
const sameOverlay = (left, right) => {
    const OVERLAY_MATCH_SIDE = 0.5; // Half a QR side retains ordinary frame-to-frame geometry drift.
    if (!left)
        return false;
    const a = left.boundingBox;
    const b = right.boundingBox;
    const side = Math.max(a.width, a.height, b.width, b.height);
    const dx = a.x + a.width / 2 - b.x - b.width / 2;
    const dy = a.y + a.height / 2 - b.y - b.height / 2;
    return dx * dx + dy * dy <= (OVERLAY_MATCH_SIDE * side) ** 2;
};
const sameOverlays = (left, right) => {
    if (left.length !== right.length)
        return false;
    for (let i = 0; i < left.length; i++) {
        let match = i;
        while (match < right.length && !sameOverlay(left[i], right[match]))
            match++;
        if (match === right.length)
            return false;
        if (match !== i) {
            const point = right[i];
            right[i] = right[match];
            right[match] = point;
        }
    }
    return true;
};
const copyOverlays = (target, source) => {
    target.length = source.length;
    for (let i = 0; i < source.length; i++)
        target[i] = source[i];
};
/**
 * Handles canvases for QR code decoding.
 * @param elements - Optional output canvases. See {@link QRCanvasElements}.
 * @param opts - Drawing and decode options for the helper canvases. See {@link QRCanvasOpts}.
 * @param _scanner - Internal scanner override used by generated comparison bundles.
 * @example
 * Create a `QRCanvas` that paints overlay highlights onto a DOM canvas.
 * ```ts
 * import { QRCanvas } from 'qr/dom.js';
 * if (typeof document !== 'undefined') {
 *   const overlay = document.createElement('canvas');
 *   const canvas = new QRCanvas({ overlay });
 *   void canvas;
 * }
 * ```
 */
export class QRCanvas {
    opts;
    reader;
    lastDetect = 0;
    scanner;
    pending;
    task;
    cleanPending = false;
    generation = 0;
    bitmapDrawn = false;
    overlayDrawn = false;
    overlayMatches = 0;
    overlayCandidate;
    overlayPoints;
    overlayBatch = [];
    overlayBatchFailed;
    overlaySet = [];
    overlayCandidates = [];
    overlaySetMatches = 0;
    overlayFailed;
    overlayFailedCandidate;
    overlayFailedCandidateSet = false;
    overlayFailedMatches = 0;
    overlayDeadline = 0;
    overlayTimer;
    rotate = false;
    sourceHeight = 0;
    sourceX = 0;
    sourceY = 0;
    inputWidth = 0;
    inputHeight = 0;
    frameSource;
    main;
    overlay;
    resultQR;
    bitmap;
    constructor(elements = {}, opts = {}, _scanner = _QRScanner) {
        const { overlay, resultQR, bitmap } = elements;
        this.opts = {
            resultBlockSize: 8,
            overlayMainColor: 'green',
            overlayFinderColor: 'blue',
            overlayAlignerColor: 'yellow',
            overlaySideColor: 'black',
            overlayTimeout: 500,
            cropToSquare: true,
            decodeAll: false,
            async: false,
            drawFailed: false,
            ...opts,
        };
        // TODO: check https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
        this.main = getCanvasContext(document.createElement('canvas'));
        if (overlay)
            this.overlay = getCanvasContext(overlay);
        if (resultQR) {
            this.resultQR = getCanvasContext(resultQR);
            this.resultQR.context.imageSmoothingEnabled = false;
        }
        if (bitmap)
            this.bitmap = getCanvasContext(bitmap);
        const decoder = {
            maxSize: { width: 3840, height: 3840 },
            stride: 4,
            textDecoder: this.opts.textDecoder,
        };
        if (this.opts.effort !== undefined)
            decoder.effort = this.opts.effort;
        if (this.opts.timeLimit !== undefined)
            decoder.timeLimit = this.opts.timeLimit;
        if (this.overlay)
            decoder.pointsOnDetect = (points, result) => {
                if (Date.now() - this.lastDetect > this.opts.overlayTimeout) {
                    this.overlayPoints = undefined;
                    this.overlayCandidate = undefined;
                    this.overlaySet.length = 0;
                    this.overlayCandidates.length = 0;
                    this.overlaySetMatches = 0;
                    this.overlayFailed = undefined;
                    this.overlayFailedCandidate = undefined;
                    this.overlayFailedCandidateSet = false;
                    this.overlayFailedMatches = 0;
                    this.overlayMatches = 0;
                }
                if (this.rotate || this.sourceX || this.sourceY) {
                    // Decode cropped coded pixels in row-contiguous orientation; only the
                    // handful of presentation coordinates need crop/rotation mapping.
                    const move = (point) => {
                        const x = point.x + this.sourceX;
                        const y = point.y + this.sourceY;
                        if (this.rotate) {
                            point.x = this.sourceHeight - 1 - y;
                            point.y = x;
                        }
                        else {
                            point.x = x;
                            point.y = y;
                        }
                    };
                    for (const point of [points.tl, points.tr, points.br, points.bl, ...points.aligners]) {
                        move(point);
                    }
                    for (const marker of [points.tl, points.tr, points.bl, ...points.aligners])
                        for (const point of marker.corners)
                            move(point);
                    for (const point of [...points.bounds, ...points.outline])
                        move(point);
                    const box = points.boundingBox;
                    const xs = points.bounds.map((point) => point.x);
                    const ys = points.bounds.map((point) => point.y);
                    box.x = Math.min(...xs);
                    box.y = Math.min(...ys);
                    box.width = Math.max(...xs) - box.x;
                    box.height = Math.max(...ys) - box.y;
                }
                if (result instanceof Error && !this.opts.drawFailed)
                    return;
                if (this.opts.decodeAll) {
                    if (result instanceof Error)
                        this.overlayBatchFailed = points;
                    else
                        this.overlayBatch.push(points);
                    return;
                }
                // Reject one-frame identity changes without delaying motion.
                if (!this.overlayPoints || sameOverlay(this.overlayPoints, points)) {
                    this.overlayPoints = points;
                    this.overlayCandidate = undefined;
                    this.overlayMatches = 0;
                }
                else {
                    if (sameOverlay(this.overlayCandidate, points))
                        this.overlayMatches++;
                    else {
                        this.overlayCandidate = points;
                        this.overlayMatches = 1;
                    }
                    if (this.overlayMatches < OVERLAY_SWITCH_FRAMES)
                        return;
                    this.overlayPoints = points;
                    this.overlayCandidate = undefined;
                    this.overlayMatches = 0;
                }
                this.drawOverlay(points, this.overlayDrawn, result instanceof Error);
                this.overlayDrawn = true;
                const now = Date.now();
                this.lastDetect = now;
                this.overlayDeadline = now + this.opts.overlayTimeout;
                // This callback runs inside measured decode time, so it only refreshes
                // the deadline. decode() arms one timer after its timing interval ends.
            };
        if (this.resultQR)
            decoder.imageOnResult = (img) => this.drawResultQr(img);
        if (this.bitmap)
            decoder.imageOnBitmap = (img) => {
                // A failing frame can emit many retry planes; retain only its first.
                if (this.bitmapDrawn)
                    return;
                this.bitmapDrawn = true;
                this.drawBitmap(img);
            };
        this.scanner = new _scanner(decoder);
        this.reader = {
            clean: () => {
                this.generation++;
                this.task?.abort();
                this.task = undefined;
                if (this.pending)
                    this.cleanPending = true;
                else
                    this.scanner.clean();
            },
            crop: this.opts.cropToSquare,
            luma: this.scanner.luma,
            frame: this.opts.onVideoFrame,
            source: (source) => {
                if (source === this.frameSource)
                    return;
                this.frameSource = source;
                if (this.opts.onFrameSource)
                    this.opts.onFrameSource(source);
            },
            read: (frame) => {
                this.rotate = frame.rotate;
                this.sourceHeight = frame.sourceHeight;
                this.sourceX = frame.sourceX;
                this.sourceY = frame.sourceY;
                this.inputWidth = frame.size.width;
                this.inputHeight = frame.size.height;
                if (this.overlay)
                    setCanvasSize(this.overlay.canvas, frame.height, frame.width);
                return this.decode(undefined, frame.format, frame.layout, frame.size);
            },
        };
    }
    drawOverlayBatch() {
        // No terminal geometry is not evidence that the displayed QR set changed;
        // retain it until the ordinary overlay deadline expires.
        if (!this.overlayBatch.length && !this.overlayBatchFailed)
            return;
        let redraw = false;
        if ((!this.overlaySet.length && this.overlayBatch.length) ||
            sameOverlays(this.overlaySet, this.overlayBatch)) {
            copyOverlays(this.overlaySet, this.overlayBatch);
            this.overlayCandidates.length = 0;
            this.overlaySetMatches = 0;
            redraw = !!this.overlaySet.length;
        }
        else {
            if (sameOverlays(this.overlayCandidates, this.overlayBatch))
                this.overlaySetMatches++;
            else {
                copyOverlays(this.overlayCandidates, this.overlayBatch);
                this.overlaySetMatches = 1;
            }
            if (this.overlaySetMatches === OVERLAY_SWITCH_FRAMES) {
                copyOverlays(this.overlaySet, this.overlayBatch);
                this.overlayCandidates.length = 0;
                this.overlaySetMatches = 0;
                redraw = true;
            }
        }
        const failed = this.overlayBatchFailed;
        if (!this.overlayFailed && failed) {
            this.overlayFailed = failed;
            this.overlayFailedCandidateSet = false;
            this.overlayFailedMatches = 0;
            redraw = true;
        }
        else if (this.overlayFailed && failed && sameOverlay(this.overlayFailed, failed)) {
            this.overlayFailed = failed;
            this.overlayFailedCandidateSet = false;
            this.overlayFailedMatches = 0;
            redraw = true;
        }
        else if (this.overlayFailed || failed) {
            if (this.overlayFailedCandidateSet &&
                ((!this.overlayFailedCandidate && !failed) ||
                    (!!this.overlayFailedCandidate &&
                        !!failed &&
                        sameOverlay(this.overlayFailedCandidate, failed))))
                this.overlayFailedMatches++;
            else {
                this.overlayFailedCandidate = failed;
                this.overlayFailedCandidateSet = true;
                this.overlayFailedMatches = 1;
            }
            if (this.overlayFailedMatches === OVERLAY_SWITCH_FRAMES) {
                this.overlayFailed = failed;
                this.overlayFailedCandidate = undefined;
                this.overlayFailedCandidateSet = false;
                this.overlayFailedMatches = 0;
                redraw = true;
            }
        }
        if (!redraw)
            return;
        this.overlayDrawn = false;
        for (let i = 0; i < this.overlaySet.length; i++) {
            this.drawOverlay(this.overlaySet[i], this.overlayDrawn, false);
            this.overlayDrawn = true;
        }
        if (this.overlayFailed) {
            this.drawOverlay(this.overlayFailed, this.overlayDrawn, true);
            this.overlayDrawn = true;
        }
        const now = Date.now();
        this.lastDetect = now;
        this.overlayDeadline = now + this.opts.overlayTimeout;
    }
    expireOverlay() {
        const remaining = this.overlayDeadline - Date.now();
        if (remaining > 0) {
            this.overlayTimer = setTimeout(() => this.expireOverlay(), remaining);
            return;
        }
        this.overlayTimer = undefined;
        this.overlayDeadline = 0;
        this.overlayDrawn = false;
        this.overlayMatches = 0;
        this.overlayCandidate = undefined;
        this.overlayPoints = undefined;
        this.overlaySet.length = 0;
        this.overlayCandidates.length = 0;
        this.overlaySetMatches = 0;
        this.overlayFailed = undefined;
        this.overlayFailedCandidate = undefined;
        this.overlayFailedCandidateSet = false;
        this.overlayFailedMatches = 0;
        this.drawOverlay();
    }
    drawBitmap({ data, height, width }) {
        if (!this.bitmap)
            return;
        // Sized to the plane (often a downscaled rung), not the source frame;
        // CSS scales it over the preview like the overlay.
        // ImageData rejects SharedArrayBuffer-backed views; both branches allocate
        // an owned ArrayBuffer and this annotation preserves that guarantee.
        let out;
        if (this.rotate) {
            out = new Uint8ClampedArray(data.length);
            for (let y = 0; y < height; y++)
                for (let x = 0; x < width; x++) {
                    const src = 4 * (y * width + x);
                    const dst = 4 * (x * height + height - 1 - y);
                    out[dst] = data[src];
                    out[dst + 1] = data[src + 1];
                    out[dst + 2] = data[src + 2];
                    out[dst + 3] = data[src + 3];
                }
            const size = width;
            width = height;
            height = size;
        }
        else
            out = Uint8ClampedArray.from(data);
        setCanvasSize(this.bitmap.canvas, height, width);
        const imgData = new ImageData(out, width, height);
        this.bitmap.context.putImageData(imgData, 0, 0);
    }
    drawResultQr({ data, height, width }) {
        if (!this.resultQR)
            return;
        const blockSize = this.opts.resultBlockSize;
        setCanvasSize(this.resultQR.canvas, height, width);
        const imgData = new ImageData(Uint8ClampedArray.from(data), width, height);
        this.resultQR.context.putImageData(imgData, 0, 0);
        // The result canvas owns these inline rendering/layout styles: CSS Images
        // defines `image-rendering: pixelated`, and scaled QR modules become hard
        // to read with default smoothing. Use class/id CSS for unrelated styling.
        this.resultQR.canvas.style = `image-rendering: pixelated; width: ${blockSize * width}px; height: ${blockSize * height}px`;
    }
    drawOverlay(points, append = false, failed = false) {
        if (!this.overlay)
            return;
        const ctx = this.overlay.context;
        const height = this.overlay.canvas.height;
        const width = this.overlay.canvas.width;
        if (!append) {
            // Sides
            if (this.opts.cropToSquare && height !== width) {
                let cropWidth = this.inputWidth || Math.min(height, width);
                let cropHeight = this.inputHeight || Math.min(height, width);
                let x = this.inputWidth ? this.sourceX : Math.floor((width - cropWidth) / 2);
                let y = this.inputHeight ? this.sourceY : Math.floor((height - cropHeight) / 2);
                if (this.rotate && this.inputWidth) {
                    // QRCamera crops coded pixels before decoding; rotate that same rect
                    // into player coordinates before painting its excluded edges.
                    const nextX = this.sourceHeight - y - cropHeight;
                    const nextY = x;
                    const nextWidth = cropHeight;
                    cropHeight = cropWidth;
                    x = nextX;
                    y = nextY;
                    cropWidth = nextWidth;
                }
                // Clear only central part (flickering)
                ctx.clearRect(x, y, cropWidth, cropHeight);
                ctx.fillStyle = this.opts.overlaySideColor;
                const right = x + cropWidth;
                const bottom = y + cropHeight;
                if (y)
                    ctx.fillRect(0, 0, width, y);
                if (bottom < height)
                    ctx.fillRect(0, bottom, width, height - bottom);
                if (x)
                    ctx.fillRect(0, y, x, cropHeight);
                if (right < width)
                    ctx.fillRect(right, y, width - right, cropHeight);
            }
            else {
                ctx.clearRect(0, 0, width, height);
            }
        }
        if (points) {
            const { tl, tr, br, bl } = points;
            // The four points are corresponding logical finder-center positions,
            // so this polygon retains the decoder's projective geometry.
            ctx.fillStyle = failed ? 'red' : this.opts.overlayMainColor;
            fillQuad(ctx, [tl, tr, br, bl]);
            // Keep the outline outside the finder edge/white separator. Its width
            // follows the detected QR scale instead of the source canvas scale.
            const moduleSize = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3;
            ctx.strokeStyle = this.opts.overlayAlignerColor;
            ctx.lineWidth = moduleSize / 2;
            traceRoundedQuad(ctx, points.outline, 9);
            ctx.stroke();
            // Finders
            ctx.fillStyle = this.opts.overlayFinderColor;
            for (const finder of [tl, tr, bl])
                fillQuad(ctx, finder.corners);
            // Aligners
            ctx.fillStyle = this.opts.overlayAlignerColor;
            for (const aligner of points.aligners)
                fillQuad(ctx, aligner.corners);
        }
    }
    finish(res) {
        let failures;
        if (res && this.opts.decodeAll) {
            failures = res;
            for (const result of res)
                if (typeof result === 'string')
                    return res;
        }
        else if (res && typeof res[0] === 'string')
            return res[0];
        // Camera-frame decoding is fail-soft UI policy: README says "even if
        // one frame fails, the next frame can succeed", so decode hook errors
        // and an empty all-result are frame misses instead of breaking the loop.
        if (this.overlay && Date.now() - this.lastDetect > this.opts.overlayTimeout)
            this.drawOverlay();
        return failures;
    }
    endDecode() {
        if (this.opts.decodeAll)
            this.drawOverlayBatch();
        if (this.overlayDeadline && this.overlayTimer === undefined)
            this.overlayTimer = setTimeout(() => this.expireOverlay(), this.opts.overlayTimeout);
    }
    decode(image, format, layout, size) {
        if (this.pending)
            return;
        this.bitmapDrawn = false;
        this.overlayDrawn = false;
        this.overlayBatch.length = 0;
        this.overlayBatchFailed = undefined;
        try {
            if (image)
                this.scanner.addImage(image, format);
            else if (size && format && layout)
                this.scanner.processImage(size, format, layout);
            else
                throw new Error('expected image or scanner-owned frame');
        }
        catch {
            this.endDecode();
            return this.finish();
        }
        if (!this.opts.async) {
            let res;
            try {
                res = this.scanner.decode(this.opts.decodeAll);
            }
            catch {
            }
            finally {
                this.endDecode();
            }
            return this.finish(res);
        }
        const decode = this.scanner.decodeAsync;
        if (!decode) {
            this.endDecode();
            return this.finish();
        }
        const generation = this.generation;
        const host = globalThis;
        const task = typeof host.TaskController === 'function' && typeof host.scheduler?.postTask === 'function'
            ? new host.TaskController()
            : undefined;
        this.task = task;
        const work = task
            ? host.scheduler.postTask(() => decode.call(this.scanner, this.opts.decodeAll), {
                signal: task.signal,
            })
            : decode.call(this.scanner, this.opts.decodeAll);
        const pending = work
            .then((res) => {
            if (generation !== this.generation)
                return;
            this.endDecode();
            return this.finish(res);
        }, () => {
            if (generation !== this.generation)
                return;
            this.endDecode();
            return this.finish();
        })
            .finally(() => {
            if (this.pending === pending)
                this.pending = undefined;
            if (this.task === task)
                this.task = undefined;
            if (this.cleanPending) {
                this.cleanPending = false;
                this.scanner.clean();
            }
        });
        this.pending = pending;
        return pending;
    }
    drawImage(image, height, width) {
        this.rotate = false;
        this.sourceHeight = height;
        const side = Math.min(width, height);
        const cropped = this.opts.cropToSquare && width !== height;
        const inputWidth = cropped ? side : width;
        const inputHeight = cropped ? side : height;
        this.sourceX = cropped ? (width - side) >> 1 : 0;
        this.sourceY = cropped ? (height - side) >> 1 : 0;
        this.inputWidth = inputWidth;
        this.inputHeight = inputHeight;
        // `resultQR` tracks decoded modules; the working canvas contains only the
        // selected source rect while the overlay retains presentation dimensions.
        setCanvasSize(this.main.canvas, inputHeight, inputWidth);
        if (this.overlay)
            setCanvasSize(this.overlay.canvas, height, width);
        const { context } = this.main;
        context.drawImage(image, -this.sourceX, -this.sourceY, width, height);
        const data = context.getImageData(0, 0, inputWidth, inputHeight);
        return this.decode(data);
    }
    clear() {
        this.reader.clean();
        this.sourceX = this.sourceY = 0;
        this.inputWidth = this.inputHeight = 0;
        if (this.overlayTimer !== undefined)
            clearTimeout(this.overlayTimer);
        this.overlayTimer = undefined;
        this.overlayDeadline = 0;
        this.overlayDrawn = false;
        this.overlayMatches = 0;
        this.overlayCandidate = undefined;
        this.overlayPoints = undefined;
        this.overlayBatch.length = 0;
        this.overlayBatchFailed = undefined;
        this.overlaySet.length = 0;
        this.overlayCandidates.length = 0;
        this.overlaySetMatches = 0;
        this.overlayFailed = undefined;
        this.overlayFailedCandidate = undefined;
        this.overlayFailedCandidateSet = false;
        this.overlayFailedMatches = 0;
        clearCanvas(this.main);
        if (this.overlay)
            clearCanvas(this.overlay);
        if (this.resultQR)
            clearCanvas(this.resultQR);
        if (this.bitmap)
            clearCanvas(this.bitmap);
    }
}
export class QRCamera {
    stream;
    player;
    opts;
    reader;
    planes = [
        { offset: 0, stride: 0 },
        { offset: 0, stride: 0 },
        { offset: 0, stride: 0 },
        { offset: 0, stride: 0 },
    ];
    layouts = [
        [this.planes[0]],
        [this.planes[0], this.planes[1]],
        [this.planes[0], this.planes[1], this.planes[2]],
        [this.planes[0], this.planes[1], this.planes[2], this.planes[3]],
    ];
    rect = { x: 0, y: 0, width: 0, height: 0 };
    nativeCopy = { rect: this.rect };
    convertedCopy = { format: 'RGBA', rect: this.rect };
    scanned = {
        format: 'I420',
        layout: { offset: 0, stride: 0 },
        rotate: false,
        size: { width: 0, height: 0 },
        sourceHeight: 0,
        sourceX: 0,
        sourceY: 0,
        width: 0,
        height: 0,
    };
    videoFrame;
    nativeOnly = false;
    reported = false;
    reading = false;
    source = 0;
    constructor(player, streamOrOpts = {}, init = {}) {
        this.player = player;
        const stream = 'getTracks' in streamOrOpts ? streamOrOpts : undefined;
        const opts = stream ? init : streamOrOpts;
        this.opts = { format: 'auto', ...opts };
        this.validateFormat(this.opts.format);
        if (stream)
            this.setStream(stream);
    }
    validateFormat(format) {
        if (format === 'auto' || format === 'canvas')
            return;
        if (format !== 'RGB' && framePlanes(format))
            return;
        throw new TypeError(`invalid opts.format=${format} (${typeof format})`);
    }
    /** Select native auto-detection, forced canvas, or one VideoFrame output format. */
    setFormat(format) {
        this.validateFormat(format);
        if (format === this.opts.format)
            return;
        this.opts.format = format;
        this.source++;
        this.videoFrame = undefined;
        this.nativeOnly = false;
        this.reported = false;
        this.resetFrame();
    }
    resetFrame() {
        this.scanned.layout.offset = 0;
        this.scanned.layout.stride = 0;
        this.scanned.rotate = false;
        this.scanned.size.width = 0;
        this.scanned.size.height = 0;
        this.scanned.sourceHeight = 0;
        this.scanned.sourceX = 0;
        this.scanned.sourceY = 0;
        this.scanned.width = 0;
        this.scanned.height = 0;
    }
    cleanFrame() {
        if (this.reader)
            this.reader.clean();
        this.reader = undefined;
        this.resetFrame();
    }
    setLayout(copy, format, width, height) {
        const planes = framePlanes(format);
        if (!planes)
            throw new Error(`Unsupported VideoFrame format=${format}`);
        let offset = 0;
        for (let i = 0; i < planes.length; i++) {
            const [xShift, yShift, bytes] = planes[i];
            const planeWidth = (width + (1 << xShift) - 1) >> xShift;
            const planeHeight = (height + (1 << yShift) - 1) >> yShift;
            const plane = this.planes[i];
            plane.offset = offset;
            plane.stride = planeWidth * bytes;
            offset += plane.stride * planeHeight;
        }
        copy.layout = this.layouts[planes.length - 1];
        return offset;
    }
    async scan(frame, reader, rotate) {
        const visible = frame.visibleRect;
        // copyTo() defaults to visibleRect and rebases its coded x/y to (0, 0).
        // Only a visible-to-display scale would remain for presentation; use the
        // canvas fallback below when those dimensions differ.
        const width = visible?.width || frame.displayWidth;
        const height = visible?.height || frame.displayHeight;
        if (!Number.isSafeInteger(width) ||
            !Number.isSafeInteger(height) ||
            width <= 0 ||
            height <= 0 ||
            width !== frame.displayWidth ||
            height !== frame.displayHeight)
            throw new Error('Unsupported VideoFrame dimensions');
        const selected = this.opts.format === 'auto' || this.nativeOnly ? frame.format : this.opts.format;
        if (!selected || selected === 'canvas')
            throw new Error(`Unsupported VideoFrame format=${selected}`);
        const planes = framePlanes(selected);
        if (!planes)
            throw new Error(`Unsupported VideoFrame format=${selected}`);
        let sourceWidth = width;
        let sourceHeight = height;
        let sourceX = 0;
        let sourceY = 0;
        if (reader.crop && width !== height) {
            let side = Math.min(width, height);
            let xShift = 0;
            let yShift = 0;
            for (const plane of planes) {
                xShift = Math.max(xShift, plane[0]);
                yShift = Math.max(yShift, plane[1]);
            }
            side -= side % (1 << Math.max(xShift, yShift));
            sourceWidth = sourceHeight = side;
            sourceX = (width - side) >> 1;
            sourceY = (height - side) >> 1;
            const alignX = 1 << xShift;
            const alignY = 1 << yShift;
            sourceX -= sourceX % alignX;
            sourceY -= sourceY % alignY;
        }
        this.rect.x = (visible?.x || 0) + sourceX;
        this.rect.y = (visible?.y || 0) + sourceY;
        this.rect.width = sourceWidth;
        this.rect.height = sourceHeight;
        // Chromium rejects an explicit non-RGB format even when it equals the
        // native format; omitting it requests the frame's native planes directly.
        const copy = selected === frame.format ? this.nativeCopy : this.convertedCopy;
        if (copy === this.convertedCopy)
            copy.format = selected;
        const required = this.setLayout(copy, selected, sourceWidth, sourceHeight);
        const size = frame.allocationSize(copy);
        if (!Number.isSafeInteger(size) || size < required || size > reader.luma.length)
            throw new Error(`Invalid VideoFrame allocation size=${size}, expected ${required}..${reader.luma.length}`);
        const [layout] = await frame.copyTo(reader.luma, copy);
        if (!layout)
            throw new Error('Missing VideoFrame plane layout');
        const presentWidth = rotate ? height : width;
        const presentHeight = rotate ? width : height;
        const scanned = this.scanned;
        scanned.format = selected;
        scanned.layout.offset = layout.offset;
        scanned.layout.stride = layout.stride;
        scanned.rotate = rotate;
        scanned.size.width = sourceWidth;
        scanned.size.height = sourceHeight;
        scanned.sourceHeight = height;
        scanned.sourceX = sourceX;
        scanned.sourceY = sourceY;
        scanned.width = presentWidth;
        scanned.height = presentHeight;
        return scanned;
    }
    setStream(stream) {
        this.stream = stream;
        this.source++;
        this.videoFrame = undefined;
        this.nativeOnly = false;
        this.reported = false;
        this.cleanFrame();
        const { player } = this;
        // Keep camera preview autoplaying inline on mobile before attaching the stream.
        player.setAttribute('autoplay', '');
        player.setAttribute('muted', '');
        player.setAttribute('playsinline', '');
        player.srcObject = stream;
    }
    /**
     * Returns list of cameras
     * NOTE: available only after first getUserMedia request, so cannot be additional method
     */
    async listDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices)
            throw new Error('Media Devices not supported');
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices
            .filter((device) => device.kind === 'videoinput')
            .map((i) => ({
            deviceId: i.deviceId,
            label: i.label || `Camera ${i.deviceId}`,
        }));
    }
    /**
     * Change stream to different camera
     * @param deviceId - devideId from '.listDevices'
     */
    async setDevice(deviceId) {
        // Stop-first is intentional for camera switching: WPT's Media Capture
        // `GUM-deny` and `GUM-impossible-constraint` tests show getUserMedia()
        // can reject, but this DOM helper prioritizes releasing constrained
        // camera hardware before requesting the replacement stream.
        this.stop();
        const source = this.source;
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: deviceId } },
        });
        // A later camera request may resolve first; never attach or leak this stale stream.
        if (source !== this.source) {
            for (const track of stream.getTracks())
                track.stop();
            return;
        }
        this.setStream(stream);
    }
    draw(canvas, fullSize) {
        const { player } = this;
        // drawImage throws while a newly attached video has no decoded frame.
        if (player.readyState < 2 || !player.videoWidth || !player.videoHeight)
            return;
        canvas['reader'].source('canvas');
        // Default to the rendered player box so overlay coordinates stay aligned
        // with the on-screen preview; `fullSize` opts into intrinsic frame pixels.
        if (fullSize)
            return canvas.drawImage(player, player.videoHeight, player.videoWidth);
        const size = getSize(player);
        return canvas.drawImage(player, size.height, size.width);
    }
    async readFrame(canvas, fullSize = false) {
        const reader = canvas['reader'];
        this.reader = reader;
        // WebCodecs exposes native intrinsic pixels, so the rendered-size mode
        // keeps its existing canvas-resampling semantics.
        if (!fullSize || this.opts.format === 'canvas' || this.videoFrame === false)
            return this.draw(canvas, fullSize);
        if (typeof VideoFrame !== 'function') {
            this.videoFrame = false;
            return this.draw(canvas, fullSize);
        }
        if (this.reading)
            return;
        this.reading = true;
        const source = this.source;
        let frame;
        try {
            frame = new VideoFrame(this.player);
        }
        catch {
            this.videoFrame = false;
            this.reading = false;
            return this.draw(canvas, fullSize);
        }
        try {
            if (!this.reported && reader.frame) {
                this.reported = true;
                reader.frame(frame);
            }
            const presented = frame;
            const { videoWidth, videoHeight } = this.player;
            // copyTo() exposes coded pixels, while the player shows presentation
            // geometry. Exact swapped dimensions are the browser's implicit portrait rotation.
            const aligned = frame.displayWidth === videoWidth && frame.displayHeight === videoHeight;
            const rotate = frame.displayWidth === videoHeight && frame.displayHeight === videoWidth;
            // Presentation can change repeatedly while a camera remains open;
            // an unsupported shape is a per-frame fallback, not a capability failure.
            if ((videoWidth > 0 && videoHeight > 0 && !aligned && !rotate) ||
                presented.rotation ||
                presented.flip)
                return this.draw(canvas, fullSize);
            let scanned;
            try {
                scanned = await this.scan(frame, reader, rotate);
            }
            catch (error) {
                const converted = !this.nativeOnly && this.opts.format !== 'auto' && this.opts.format !== frame.format;
                if (!converted)
                    throw error;
                // A browser may expose native YUV copying but reject YUV conversion.
                // Cache only the failed conversion and retain the direct native path.
                this.nativeOnly = true;
                this.resetFrame();
                scanned = await this.scan(frame, reader, rotate);
            }
            if (source !== this.source) {
                this.resetFrame();
                return;
            }
            // Do not publish decode/overlay coordinates prepared for stale player geometry.
            if (this.player.videoWidth !== videoWidth || this.player.videoHeight !== videoHeight)
                return;
            this.videoFrame = true;
            reader.source('VideoFrame');
            return reader.read(scanned);
        }
        catch {
            this.resetFrame();
            if (source !== this.source)
                return;
            // A constructor can exist while copyTo/native format support does not;
            // cache that result for this source so only the first frame pays it.
            this.videoFrame = false;
            return this.draw(canvas, fullSize);
        }
        finally {
            frame.close();
            this.reading = false;
        }
    }
    stop() {
        this.source++;
        this.videoFrame = undefined;
        this.nativeOnly = false;
        this.reported = false;
        this.cleanFrame();
        if (this.stream)
            for (const track of this.stream.getTracks())
                track.stop();
        this.stream = undefined;
    }
}
// Media Capture terms: 'environment' = rear/world-facing, 'user' = selfie.
async function openCamera(player, facingMode, opts = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            // Ask for screen resolution
            height: { ideal: window.screen.height },
            width: { ideal: window.screen.width },
            facingMode,
        },
    });
    return new QRCamera(player, stream, opts);
}
/**
 * Creates new QRCamera from the rear (environment-facing) camera — the side
 * you point at a QR code, usually the right choice for scanning. Use
 * `camera.setDevice()` to switch to another one.
 * @param player - HTML Video element
 * @returns Camera wrapper backed by the selected media stream.
 * @example
 * Create a camera helper and read frames into a `QRCanvas`.
 * ```ts
 * import { QRCanvas, rearCamera } from 'qr/dom.js';
 * if (typeof document !== 'undefined') {
 *   const player = document.querySelector('video')!;
 *   const canvas = new QRCanvas();
 *   const camera = await rearCamera(player);
 *   await camera.readFrame(canvas);
 *   camera.stop();
 * }
 * ```
 */
export async function rearCamera(player, opts = {}) {
    return openCamera(player, 'environment', opts);
}
/**
 * Creates new QRCamera from the user-facing (selfie) camera — e.g. for
 * scanning a code held up to a laptop webcam, or when the rear camera is
 * broken or covered. Mirrors nothing: frames arrive unflipped, which is what
 * the decoder wants.
 * @param player - HTML Video element
 * @returns Camera wrapper backed by the selected media stream.
 * @example
 * Create a selfie-camera helper and read frames into a `QRCanvas`.
 * ```ts
 * import { QRCanvas, selfieCamera } from 'qr/dom.js';
 * if (typeof document !== 'undefined') {
 *   const player = document.querySelector('video')!;
 *   const canvas = new QRCanvas();
 *   const camera = await selfieCamera(player);
 *   await camera.readFrame(canvas);
 *   camera.stop();
 * }
 * ```
 */
export async function selfieCamera(player, opts = {}) {
    return openCamera(player, 'user', opts);
}
/**
 * Run callback in a loop with requestAnimationFrame.
 * @param cb - Callback invoked for each requested animation frame.
 * @param video - Optional player whose newly presented frames drive the loop.
 * @returns Canceller that stops the scheduled loop.
 * @example
 * Run a callback on every animation frame until cancelled.
 * ```ts
 * import { frameLoop } from 'qr/dom.js';
 * if (typeof requestAnimationFrame !== 'undefined') {
 *   const cancel = frameLoop(() => {});
 *   cancel();
 * }
 * ```
 */
export function frameLoop(cb, video) {
    const useVideo = !!video &&
        typeof video.requestVideoFrameCallback === 'function' &&
        typeof video.cancelVideoFrameCallback === 'function';
    const request = () => useVideo ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
    const cancel = (id) => useVideo ? video.cancelVideoFrameCallback(id) : cancelAnimationFrame(id);
    let active = true;
    let handle = undefined;
    function loop(ts) {
        // HTML `AnimationFrameProvider` IDL defines `FrameRequestCallback` as
        // `undefined (DOMHighResTimeStamp time)`. Check active after the callback because
        // callers may stop the loop from inside that callback before another frame exists.
        cb(ts);
        if (active)
            handle = request();
    }
    handle = request();
    return () => {
        if (!active)
            return;
        active = false;
        if (handle !== undefined)
            cancel(handle);
        handle = undefined;
    };
}
/**
 * Convert an SVG string into a PNG data URL in browser environments.
 * @param svgData - SVG markup to rasterize.
 * @param width - Output PNG width in pixels.
 * @param height - Output PNG height in pixels.
 * @returns Promise that resolves to a PNG `data:` URL.
 * @example
 * Convert an SVG string into a PNG data URL in browser environments.
 * ```ts
 * import { svgToPng } from 'qr/dom.js';
 * const svg =
 *   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
 *   '<rect width="1" height="1"/></svg>';
 * if (typeof DOMParser !== 'undefined' && typeof document !== 'undefined') {
 *   const pngUrl = await svgToPng(svg, 256, 256);
 *   void pngUrl;
 * }
 * ```
 */
export function svgToPng(svgData, width, height) {
    return new Promise((resolve, reject) => {
        if (!(Number.isSafeInteger(width) &&
            Number.isSafeInteger(height) &&
            width > 0 &&
            height > 0 &&
            width < 8192 &&
            height < 8192))
            return reject(new Error('invalid width and height: ' + width + ' ' + height));
        const domparser = new DOMParser();
        const doc = domparser.parseFromString(svgData, 'image/svg+xml');
        const svgElement = doc.documentElement;
        svgElement.setAttribute('width', String(width));
        svgElement.setAttribute('height', String(height));
        const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('width', '100%');
        rect.setAttribute('height', '100%');
        rect.setAttribute('fill', 'white');
        svgElement.insertBefore(rect, svgElement.firstChild);
        const serializer = new XMLSerializer();
        const source = serializer.serializeToString(doc);
        const img = new Image();
        // HTMLImageElement IDL exposes `src` as the URL attribute and `onload` /
        // `onerror` as EventHandler attributes. Register handlers before mutating
        // `src` so a fast image implementation cannot complete before listeners
        // exist.
        img.onload = function () {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx)
                return reject(new Error('was not able to create 2d context'));
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/png');
            resolve(dataUrl);
        };
        img.onerror = reject;
        img.src = 'data:image/svg+xml,' + encodeURIComponent(source);
    });
}
/**
 * Convert GIF bytes into a PNG blob in browser environments.
 * @param gifBytes - GIF file contents.
 * @returns Promise that resolves to a PNG blob.
 * @throws {@link Error} if the browser cannot create an image bitmap or rendering context.
 * @example
 * Convert GIF bytes into a PNG blob in browser environments.
 * ```ts
 * import { gifToPng } from 'qr/dom.js';
 * if (typeof window !== 'undefined') {
 *   const gif = new Uint8Array(await (await fetch('/qr.gif')).arrayBuffer());
 *   const png = await gifToPng(gif);
 *   void png;
 * }
 * ```
 */
export async function gifToPng(gifBytes) {
    const blob = new Blob([gifBytes], { type: 'image/gif' });
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('bitmaprenderer', { alpha: false });
        if (!ctx)
            throw new Error('was not able to create bitmaprenderer context');
        ctx.transferFromImageBitmap(bitmap);
        return await canvas.convertToBlob({ type: 'image/png' });
    }
    finally {
        // Release the decoded bitmap even when context creation or PNG encoding fails.
        bitmap.close();
    }
}
