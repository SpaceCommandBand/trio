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
let lastChordSelect = 0.5; // last subX sent to WASM, for debug display
let voicePitches = { lead: 0, lower: 0, upper: 0 };

const NOTE_NAMES_12 = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function midiToName(midi) {
    if (!midi) return '-';
    const oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES_12[midi % 12] + oct;
}

// Left→right zone order: aug, maj, min, dim
const CHORD_TYPE_NAMES = ['aug', 'maj', 'min', 'dim'];
function chordTypeName(subX) {
    return CHORD_TYPE_NAMES[Math.min(3, Math.floor(subX * 4))];
}

// Zone colors indexed by chord type [aug=0, maj=1, min=2, dim=3]
const ZONE_WHITE     = ['#f3eaf9', '#fefde8', '#eef4ff', '#edfbf3'];
const ZONE_WHITE_ACT = ['#d8b4f8', '#fde68a', '#bfdbfe', '#a7f3d0'];
const ZONE_BLACK     = ['#3b1a6e', '#422006', '#0f2557', '#052e1c'];
const ZONE_BLACK_ACT = ['#6d28d9', '#b45309', '#1d4ed8', '#065f46'];

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

function getDebugPanelHeight() {
    const lineH = 15;
    const pad = 8;
    return pad + (4 + dbgLog.length) * lineH + pad; // 4 permanent lines
}

function getPianoMetrics() {
    const zoneTop = getDebugPanelHeight();
    const zoneH = Math.round(canvas.height * 0.25); // 25% of window height, keys only
    const keyH = zoneH;
    const wkw = canvas.width / NUM_WU;
    const bkw = wkw * 0.58;
    const bkh = keyH * 0.6;
    return { zoneTop, keyH, wkw, bkw, bkh, zoneH };
}

function getControlsMetrics() {
    const { zoneTop, zoneH } = getPianoMetrics();
    const controlsTop = zoneTop + zoneH + 28;
    const controlsH = OCT_H;
    const cy = controlsTop + controlsH / 2;
    return { controlsTop, controlsH, cy };
}

function hitTestOctave(px, py) {
    const { controlsTop, controlsH } = getControlsMetrics();
    if (py < controlsTop || py > controlsTop + controlsH) return 0;

    const btnW = OCT_H * 1.4;
    ctx.font = `bold ${OCT_H * 0.52}px sans-serif`;
    const labelW = ctx.measureText(baseNoteName()).width;
    const gap = 8;
    const groupW = btnW + gap + labelW + gap + btnW;
    const groupX = (canvas.width * 0.38 - groupW) / 2;
    const upX = groupX + btnW + gap + labelW + gap;

    if (px >= groupX && px <= groupX + btnW) return -1;
    if (px >= upX && px <= upX + btnW) return +1;
    return 0;
}

function hitTestPiano(px, py) {
    const { zoneTop, keyH, wkw, bkw, bkh } = getPianoMetrics();
    const ky = py - zoneTop;
    if (ky < 0 || ky >= keyH) return -1;

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

    // Sub-key X position (0=left edge, 1=right edge) → chord candidate selection
    const { wkw, bkw } = getPianoMetrics();
    let subX;
    if (isBlack[noteIdx]) {
        const cx = KEY_WU_POS[noteIdx] * wkw;
        subX = clamp((xpos - (cx - bkw / 2)) / bkw, 0, 1);
    } else {
        const wkIdx = WHITE_NOTES.indexOf(noteIdx);
        subX = clamp((xpos - wkIdx * wkw) / wkw, 0, 1);
    }
    lastChordSelect = subX;
    trioNode.setChordSelect(subX);
}

function sendGateEvent(turnOn) {
    if (trioNode == null) return;
    if (turnOn) {
        trioNode.on();
    } else {
        trioNode.off();
        activeNote = -1;
    }
}

function speedHz() {
    // Logarithmic: 0.25 Hz at t=0, 1.0 Hz at t=0.5, 4.0 Hz at t=1
    return 0.25 * Math.pow(16, speedT);
}

function getSpeedMetrics() {
    const { controlsTop, controlsH, cy } = getControlsMetrics();
    const sliderX = Math.round(canvas.width * 0.50);
    const sliderW = Math.round(canvas.width * 0.44);
    const sliderY = Math.round(cy) + 6;
    const thumbR = 8;
    const trackH = 4;
    return { sliderX, sliderW, sliderY, thumbR, trackH, controlsTop, controlsH, cy };
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
    const { zoneTop, keyH, wkw, bkw, bkh } = getPianoMetrics();
    const labelSize = Math.max(9, wkw * 0.32);
    const keyBottom = zoneTop + keyH;

    // White keys — 4 chord-type zones per key
    for (let w = 0; w < WHITE_NOTES.length; w++) {
        const noteIdx = WHITE_NOTES[w];
        const x = w * wkw;
        const active = activeNote === noteIdx;
        const colors = active ? ZONE_WHITE_ACT : ZONE_WHITE;
        const zw = (wkw - 1) / 4;

        for (let z = 0; z < 4; z++) {
            ctx.fillStyle = colors[z];
            ctx.fillRect(x + 0.5 + z * zw, zoneTop + 0.5, zw, keyH - 1);
        }
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, zoneTop + 1, wkw - 2, keyH - 2);
        // subtle zone dividers
        ctx.strokeStyle = 'rgba(0,0,0,0.10)';
        ctx.lineWidth = 1;
        for (let z = 1; z < 4; z++) {
            const zx = x + 0.5 + z * zw;
            ctx.beginPath();
            ctx.moveTo(zx, zoneTop + 0.5);
            ctx.lineTo(zx, zoneTop + keyH - 0.5);
            ctx.stroke();
        }

        if (noteIdx % 12 === 0) {
            ctx.fillStyle = '#888';
            ctx.font = `${labelSize}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('C', x + wkw / 2, keyBottom - 8);
        }
    }

    // Black keys — 4 chord-type zones per key
    for (let i = 0; i < totalSteps; i++) {
        if (!isBlack[i]) continue;
        const cx = KEY_WU_POS[i] * wkw;
        const bx = cx - bkw / 2;
        const active = activeNote === i;
        const colors = active ? ZONE_BLACK_ACT : ZONE_BLACK;
        const bz = bkw / 4;

        for (let z = 0; z < 4; z++) {
            ctx.fillStyle = colors[z];
            ctx.fillRect(bx + z * bz, zoneTop, bz, bkh);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx + 2, zoneTop + 2, bkw - 4, bkh * 0.15);
    }
}

function drawControls() {
    const { controlsTop, controlsH, cy } = getControlsMetrics();
    const cw = canvas.width;

    ctx.fillStyle = '#003d3d';
    ctx.fillRect(0, controlsTop, cw, controlsH);

    // Octave control: [◀]  C4  [▶] on the left side
    const btnW = OCT_H * 1.4;
    const btnH = OCT_H - 8;
    const labelFont = `bold ${OCT_H * 0.52}px sans-serif`;
    ctx.font = labelFont;
    const labelW = ctx.measureText(baseNoteName()).width;
    const gap = 8;
    const groupW = btnW + gap + labelW + gap + btnW;
    const groupX = (cw * 0.38 - groupW) / 2;
    const textY = cy + OCT_H * 0.18;

    ctx.fillStyle = octaveOffset > -3 ? '#005555' : '#003333';
    ctx.fillRect(groupX, controlsTop + 4, btnW, btnH);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('◀', groupX + btnW / 2, textY);

    ctx.fillStyle = '#7ecfcf';
    ctx.fillText(baseNoteName(), groupX + btnW + gap + labelW / 2, textY);

    const upX = groupX + btnW + gap + labelW + gap;
    ctx.fillStyle = octaveOffset < 3 ? '#005555' : '#003333';
    ctx.fillRect(upX, controlsTop + 4, btnW, btnH);
    ctx.fillStyle = '#fff';
    ctx.fillText('▶', upX + btnW / 2, textY);

    // Speed slider on the right side
    const { sliderX, sliderW, sliderY, thumbR, trackH } = getSpeedMetrics();
    const thumbX = sliderX + speedT * sliderW;
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
        const chordName = activeNote >= 0
            ? `${NOTE_NAMES[activeNote % 12]}${chordTypeName(lastChordSelect)}`
            : '-';
        const lines = [
            `AudioContext: ${audioContext.state}`,
            `gate: ${gate}  note: ${activeNote >= 0 ? NOTE_NAMES[activeNote] : '-'}  oct: ${baseNoteName()}`,
            `chord: ${chordName}  sel: ${lastChordSelect.toFixed(2)}`,
            `voices: ${midiToName(voicePitches.lead)}  ${midiToName(voicePitches.lower)}  ${midiToName(voicePitches.upper)}`,
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

    drawControls();

    // Touch indicator in free space below controls
    if (gate && activeNote >= 0 && circX >= 0) {
        const { controlsTop, controlsH } = getControlsMetrics();
        const controlsBottom = controlsTop + controlsH;
        const iy = controlsBottom + (canvas.height - controlsBottom) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(circX, iy, 44, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = '#006262';
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'center';
        const chordLabel = `${NOTE_NAMES[activeNote % 12]}${chordTypeName(lastChordSelect)}`;
        ctx.fillText(chordLabel, circX, iy + 8);
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
    gate = false;
    sendGateEvent(false);
}

function cancel(event) {
    draggingSpeed = false;
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
        trioNode.port.onmessage = (event) => {
            if (event.data.type === 'pitches') {
                voicePitches = event.data;
            } else if (event.data.type === 'workletReady') {
                dbg(`worklet ready, pitchExports=${event.data.hasPitchExports}`);
            }
        };
        applyOctave();
        applySpeed();
    }
});

canvas.addEventListener('pointerdown', down, false);
canvas.addEventListener('pointermove', move, false);
canvas.addEventListener('pointerup', up, false);
canvas.addEventListener('pointercancel', cancel, false);

draw();
