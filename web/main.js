import { startAudio, getGlobalTrio } from "./audio.js";
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioContext = new AudioContext();

const canvas = document.getElementById('canvas');
const html = document.getElementsByTagName('html')[0];
const container = document.getElementById('container');

canvas.width = 500;
canvas.height = 500;
const ctx = canvas.getContext('2d');

let gate = false;
let circX = -1;
let circY = -1;
const totalSteps = 28;
let audioStarted = false;
let trioNode = null;
let activeNote = -1;
let octaveOffset = 0; // semitone shift in multiples of 12; default C4
let speedT = 0.5;    // normalized slider position; 0.5 → 1.0 Hz (default)
let draggingSpeed = false;

// Debug log
const DBG_MAX = 6;
const dbgLog = [];
function dbg(msg) {
    const ts = audioStarted ? ((performance.now() / 1000).toFixed(1) + 's') : '--';
    dbgLog.unshift(`[${ts}] ${msg}`);
    if (dbgLog.length > DBG_MAX) dbgLog.pop();
}
audioContext.onstatechange = () => dbg(`AudioContext → ${audioContext.state}`);

// 28 chromatic semitones: C to D# (2 octaves + 4 notes)
const isBlack = [
    false, true, false, true, false, false, true, false, true, false, true, false, // C–B
    false, true, false, true, false, false, true, false, true, false, true, false, // C–B
    false, true, false, true  // C C# D D#
];

const NOTE_NAMES = [
    'C','C#','D','D#','E','F','F#','G','G#','A','A#','B',
    'C','C#','D','D#','E','F','F#','G','G#','A','A#','B',
    'C','C#','D','D#'
];

// White keys in order (16 total)
const WHITE_NOTES = [0,2,4,5,7,9,11, 12,14,16,17,19,21,23, 24,26];

// Center x position for each note in white-key units
const KEY_WU_POS = [
    0.5,  // C
    1.0,  // C#
    1.5,  // D
    2.0,  // D#
    2.5,  // E
    3.5,  // F
    4.0,  // F#
    4.5,  // G
    5.0,  // G#
    5.5,  // A
    6.0,  // A#
    6.5,  // B
    7.5,  // C
    8.0,  // C#
    8.5,  // D
    9.0,  // D#
    9.5,  // E
    10.5, // F
    11.0, // F#
    11.5, // G
    12.0, // G#
    12.5, // A
    13.0, // A#
    13.5, // B
    14.5, // C
    15.0, // C#
    15.5, // D
    16.0, // D# (trailing)
];

// 17 WU wide: 16 white keys + room for trailing D# black key
const NUM_WU = 17;

// Height of octave control strip at bottom of keyboard zone
const OCT_H = 40;

function getPianoMetrics() {
    const zoneH = canvas.height * 0.8;       // full keyboard zone
    const zoneTop = canvas.height - zoneH;
    const keyH = zoneH - OCT_H;              // actual key height
    const octTop = zoneTop + keyH;           // top of octave strip
    const wkw = canvas.width / NUM_WU;
    const bkw = wkw * 0.58;
    const bkh = keyH * 0.6;
    return { zoneTop, keyH, octTop, wkw, bkw, bkh };
}

function hitTestOctave(px, py) {
    const { octTop } = getPianoMetrics();
    if (py < octTop || py > canvas.height) return 0;

    const cw = canvas.width;
    const btnW = OCT_H * 1.4;
    const labelFont = `bold ${OCT_H * 0.52}px sans-serif`;
    ctx.font = labelFont;
    const labelW = ctx.measureText(baseNoteName()).width;
    const gap = 8;
    const groupW = btnW + gap + labelW + gap + btnW;
    const groupX = (cw - groupW) / 2;
    const upX = groupX + btnW + gap + labelW + gap;

    if (px >= groupX && px <= groupX + btnW) return -1;
    if (px >= upX && px <= upX + btnW) return +1;
    return 0;
}

function hitTestPiano(px, py) {
    const { zoneTop, keyH, octTop, wkw, bkw, bkh } = getPianoMetrics();
    const ky = py - zoneTop;
    if (ky < 0 || py >= octTop) return -1;

    // Black keys take priority
    if (ky < bkh) {
        for (let i = 0; i < totalSteps; i++) {
            if (isBlack[i]) {
                const cx = KEY_WU_POS[i] * wkw;
                if (Math.abs(px - cx) < bkw / 2) return i;
            }
        }
    }

    const wkIdx = Math.floor(px / wkw);
    if (wkIdx >= 0 && wkIdx < WHITE_NOTES.length) return WHITE_NOTES[wkIdx];
    return -1;
}

function clamp(x, mn, mx) {
    return x < mn ? mn : x > mx ? mx : x;
}

function sendMoveEvent(xpos, ypos) {
    if (trioNode == null || !gate) return;
    if (canvas.width == 0 || canvas.height == 0) return;

    const noteIdx = hitTestPiano(xpos, ypos);
    if (noteIdx < 0) return;

    activeNote = noteIdx;
    const xpos_norm = (noteIdx + 0.5) / totalSteps;
    const ypos_norm = clamp(ypos / canvas.height, 0, 1);
    trioNode.move(xpos_norm, ypos_norm);
}

function sendGateEvent(turnOn) {
    if (trioNode == null) return;
    if (turnOn) {
        dbg(`gate ON  note=${activeNote}`);
        trioNode.on();
    } else {
        dbg(`gate OFF`);
        trioNode.off();
        activeNote = -1;
    }
}

function speedHz() {
    // Logarithmic: 0.25 Hz at t=0, 1.0 Hz at t=0.5, 4.0 Hz at t=1
    return 0.25 * Math.pow(16, speedT);
}

function getSpeedMetrics() {
    const sliderX = Math.round(canvas.width * 0.66);
    const sliderW = Math.round(canvas.width * 0.30);
    const sliderY = 26;
    const thumbR = 8;
    const trackH = 4;
    return { sliderX, sliderW, sliderY, thumbR, trackH };
}

function hitTestSpeed(px, py) {
    const { sliderX, sliderW, sliderY, thumbR } = getSpeedMetrics();
    if (py < sliderY - thumbR * 2.5 || py > sliderY + thumbR * 2.5) return null;
    if (px < sliderX - thumbR || px > sliderX + sliderW + thumbR) return null;
    return Math.max(0, Math.min(1, (px - sliderX) / sliderW));
}

function applySpeed() {
    if (trioNode == null) return;
    trioNode.setSpeed(speedHz());
}

function applyOctave() {
    if (trioNode == null) return;
    trioNode.setBase(60 + octaveOffset * 12);
}

function baseNoteName() {
    const midi = 60 + octaveOffset * 12;
    const oct = Math.floor(midi / 12) - 1;
    return `C${oct}`;
}

function drawPianoKeyboard() {
    const { zoneTop, keyH, octTop, wkw, bkw, bkh } = getPianoMetrics();
    const labelSize = Math.max(9, wkw * 0.32);

    // White keys
    for (let w = 0; w < WHITE_NOTES.length; w++) {
        const noteIdx = WHITE_NOTES[w];
        const x = w * wkw;
        const active = activeNote === noteIdx;

        ctx.fillStyle = active ? '#aadff0' : '#f8f8f8';
        ctx.fillRect(x + 0.5, zoneTop + 0.5, wkw - 1, keyH - 1);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, zoneTop + 0.5, wkw - 1, keyH - 1);

        if (noteIdx % 12 === 0) {
            ctx.fillStyle = '#999';
            ctx.font = `${labelSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('C', x + wkw / 2, octTop - 8);
        }
    }

    // Black keys
    for (let i = 0; i < totalSteps; i++) {
        if (!isBlack[i]) continue;
        const cx = KEY_WU_POS[i] * wkw;
        const x = cx - bkw / 2;
        const active = activeNote === i;

        ctx.fillStyle = active ? '#336699' : '#111';
        ctx.fillRect(x, zoneTop, bkw, bkh);
        ctx.fillStyle = active ? 'rgba(100,180,255,0.3)' : 'rgba(255,255,255,0.08)';
        ctx.fillRect(x + 2, zoneTop + 2, bkw - 4, bkh * 0.15);
    }

    // Octave control strip: [◀]  C4  [▶] grouped in the centre
    const cw = canvas.width;
    ctx.fillStyle = '#003d3d';
    ctx.fillRect(0, octTop, cw, OCT_H);

    const btnW = OCT_H * 1.4;
    const btnH = OCT_H - 8;
    const labelFont = `bold ${OCT_H * 0.52}px sans-serif`;
    const cy = octTop + OCT_H / 2;

    // Measure label width to pack buttons tightly around it
    ctx.font = labelFont;
    const labelW = ctx.measureText(baseNoteName()).width;
    const gap = 8;
    const groupW = btnW + gap + labelW + gap + btnW;
    const groupX = (cw - groupW) / 2;

    // Down button ◀
    ctx.fillStyle = octaveOffset > -3 ? '#005555' : '#003333';
    ctx.fillRect(groupX, octTop + 4, btnW, btnH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('◀', groupX + btnW / 2, cy + OCT_H * 0.18);

    // Label
    ctx.fillStyle = '#7ecfcf';
    ctx.fillText(baseNoteName(), groupX + btnW + gap + labelW / 2, cy + OCT_H * 0.18);

    // Up button ▶
    const upX = groupX + btnW + gap + labelW + gap;
    ctx.fillStyle = octaveOffset < 3 ? '#005555' : '#003333';
    ctx.fillRect(upX, octTop + 4, btnW, btnH);
    ctx.fillStyle = '#fff';
    ctx.fillText('▶', upX + btnW / 2, cy + OCT_H * 0.18);
}

function draw() {
    canvas.width = html.clientWidth;
    canvas.height = html.clientHeight;

    ctx.fillStyle = '#006262';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!audioStarted) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 48px sans-serif';
        ctx.fillText('TAP TO BEGIN', canvas.width / 2, canvas.height / 2);
        window.requestAnimationFrame(draw);
        return;
    }

    // Debug panel (top-left)
    {
        const lineH = 15;
        const pad = 8;
        const lines = [
            `AudioContext: ${audioContext.state}`,
            `gate: ${gate}  note: ${activeNote >= 0 ? NOTE_NAMES[activeNote] : '-'}  oct: ${baseNoteName()}`,
            ...dbgLog
        ];
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, canvas.width * 0.62, pad + lines.length * lineH + pad);
        ctx.font = '12px monospace';
        ctx.textAlign = 'left';
        lines.forEach((l, i) => {
            ctx.fillStyle = i < 2 ? '#7ff' : '#aaa';
            ctx.fillText(l, pad, pad + lineH * i + lineH - 2);
        });
    }

    // Speed slider (top-right)
    {
        const { sliderX, sliderW, sliderY, thumbR, trackH } = getSpeedMetrics();
        const thumbX = sliderX + speedT * sliderW;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(sliderX - thumbR - 4, 0, sliderW + thumbR * 2 + 8, sliderY + thumbR + 8);
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillStyle = '#7ecfcf';
        ctx.fillText(`SPEED  ${speedHz().toFixed(2)}Hz`, sliderX, sliderY - thumbR - 2);
        ctx.fillStyle = '#004444';
        ctx.fillRect(sliderX, sliderY - trackH / 2, sliderW, trackH);
        ctx.fillStyle = '#00aaaa';
        ctx.fillRect(sliderX, sliderY - trackH / 2, speedT * sliderW, trackH);
        ctx.fillStyle = draggingSpeed ? '#fff' : '#7ecfcf';
        ctx.beginPath();
        ctx.arc(thumbX, sliderY, thumbR, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Touch indicator in upper area
    if (gate && activeNote >= 0 && circX >= 0) {
        const { zoneTop } = getPianoMetrics();
        const iy = Math.min(circY, zoneTop - 50);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(circX, iy, 44, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#006262';
        ctx.font = 'bold 22px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(NOTE_NAMES[activeNote], circX, iy + 8);
    }

    drawPianoKeyboard();
    window.requestAnimationFrame(draw);
}

function down(event) {
    const sT = hitTestSpeed(event.clientX, event.clientY);
    if (sT !== null) {
        draggingSpeed = true;
        speedT = sT;
        applySpeed();
        return;
    }
    const oct = hitTestOctave(event.clientX, event.clientY);
    if (oct !== 0) {
        octaveOffset = clamp(octaveOffset + oct, -3, 3);
        applyOctave();
        dbg(`octave → ${baseNoteName()}`);
        return;
    }
    circX = event.clientX;
    circY = event.clientY;
    gate = true;
    sendGateEvent(true);
    sendMoveEvent(circX, circY);
}

function up(event) {
    draggingSpeed = false;
    dbg(`pointerup id=${event ? event.pointerId : '?'}`);
    gate = false;
    sendGateEvent(false);
}

function cancel(event) {
    draggingSpeed = false;
    dbg(`pointercancel id=${event ? event.pointerId : '?'}`);
    gate = false;
    sendGateEvent(false);
}

function move(event) {
    if (draggingSpeed) {
        const { sliderX, sliderW } = getSpeedMetrics();
        speedT = Math.max(0, Math.min(1, (event.clientX - sliderX) / sliderW));
        applySpeed();
        return;
    }
    circX = event.clientX;
    circY = event.clientY;
    sendMoveEvent(circX, circY);
}

container.addEventListener('click', async () => {
    if (!audioStarted) {
        await startAudio(audioContext);
        audioStarted = true;
        audioContext.resume();
        trioNode = getGlobalTrio();
        applyOctave();
        applySpeed();
    }
});

canvas.addEventListener('pointerdown', down, false);
canvas.addEventListener('pointermove', move, false);
canvas.addEventListener('pointerup', up, false);
canvas.addEventListener('pointercancel', cancel, false);

draw();
