class TrioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        const wasmBytes = options.processorOptions.wasmBytes;

        const mod = new WebAssembly.Module(wasmBytes);
        this.wasm = new WebAssembly.Instance(mod, {});

        this.dsp = this.wasm.exports.newdsp(sampleRate);
        this.outptr = this.wasm.exports.alloc(128);
        this.outbuf = new Float32Array(
            this.wasm.exports.memory.buffer,
            this.outptr,
            128
        );
        this.pitchPostCounter = 0;
        this.hasPitchExports = (
            typeof this.wasm.exports.vox_get_lead_pitch === 'function' &&
            typeof this.wasm.exports.vox_get_lower_pitch === 'function' &&
            typeof this.wasm.exports.vox_get_upper_pitch === 'function'
        );
        this.port.onmessage =
            (event) => this.onmessage(event.data);
        // Notify main thread whether pitch exports are available
        this.port.postMessage({ type: 'workletReady', hasPitchExports: this.hasPitchExports });
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];

        this.wasm.exports.process(this.dsp, this.outptr, 128);
        for (let c = 0; c < output.length; ++c) {
            const outChan = output[c];
            for (let i = 0; i < outChan.length; ++i) {
                outChan[i] = this.outbuf[i];
            }
        }

        // Post voice pitches to main thread ~15 times/sec (every 200 blocks)
        if (this.hasPitchExports) {
            this.pitchPostCounter++;
            if (this.pitchPostCounter >= 200) {
                this.pitchPostCounter = 0;
                const lead  = this.wasm.exports.vox_get_lead_pitch(this.dsp);
                const lower = this.wasm.exports.vox_get_lower_pitch(this.dsp);
                const upper = this.wasm.exports.vox_get_upper_pitch(this.dsp);
                this.port.postMessage({ type: 'pitches', lead, lower, upper });
            }
        }

        return true;
    }

    onmessage(event) {
        if (event.type == "move") {
            //console.log("processor move 2", event.x, event.y);
            this.wasm.exports.vox_x_axis(this.dsp, event.x);
            this.wasm.exports.vox_y_axis(this.dsp, 1.0 - event.y);
        } else if (event.type == "off") {
            //console.log("proc up 2");
            this.wasm.exports.vox_gate(this.dsp, 0.0);
        } else if (event.type == "on") {
            console.log("proc down 2");
            this.wasm.exports.vox_gate(this.dsp, 1.0);
        } else if (event.type == "setBase") {
            this.wasm.exports.vox_set_base(this.dsp, event.midi);
        } else if (event.type == "setSpeed") {
            this.wasm.exports.vox_set_speed(this.dsp, event.freq);
        } else if (event.type == "setChordSelect") {
            this.wasm.exports.vox_set_chord_select(this.dsp, event.t);
        }
    }
}

registerProcessor('trio', TrioProcessor);
