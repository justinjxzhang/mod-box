import { EventEmitter } from "events";

export enum RotaryDirection {
    DIR_CW = 'DIR_CW',
    DIR_CCW = 'DIR_CCW'
};

export class Rotary extends EventEmitter {
    // Shamelessly stolen from buxtronix
    static R_START = 0x0;
    static R_CW_FINAL = 0x1;
    static R_CW_BEGIN = 0x2;
    static R_CW_NEXT = 0x3;
    static R_CCW_BEGIN = 0x4;
    static R_CCW_FINAL = 0x5;
    static R_CCW_NEXT = 0x6;

    static DIR_NONE = 0x0;
    static DIR_CW = 0x10;
    static DIR_CCW = 0x20;

    static grayTable: number[][] = [
        [Rotary.R_START,    Rotary.R_CW_BEGIN,  Rotary.R_CCW_BEGIN, Rotary.R_START],
        // Rotary.R_CW_FINAL
        [Rotary.R_CW_NEXT,  Rotary.R_START,     Rotary.R_CW_FINAL,  Rotary.R_START | Rotary.DIR_CW],
        // Rotary.R_CW_BEGIN
        [Rotary.R_CW_NEXT,  Rotary.R_CW_BEGIN,  Rotary.R_START,     Rotary.R_START],
        // Rotary.R_CW_NEXT
        [Rotary.R_CW_NEXT,  Rotary.R_CW_BEGIN,  Rotary.R_CW_FINAL,  Rotary.R_START],
        // Rotary.R_CCW_BEGIN
        [Rotary.R_CCW_NEXT, Rotary.R_START,     Rotary.R_CCW_BEGIN, Rotary.R_START],
        // Rotary.R_CCW_FINAL
        [Rotary.R_CCW_NEXT, Rotary.R_CCW_FINAL, Rotary.R_START,     Rotary.R_START | Rotary.DIR_CCW],
        // Rotary.R_CCW_NEXT
        [Rotary.R_CCW_NEXT, Rotary.R_CCW_FINAL, Rotary.R_CCW_BEGIN, Rotary.R_START],
    ];

    private state = Rotary.R_START;

    private lastClk = false;
    private lastDt = false;

    constructor(private activeHigh = false) {
        super();
    }

    check(clk: boolean, dt: boolean) {
        this.lastClk = clk;
        this.lastDt = dt;
        const inputState = (((clk ? this.activeHigh : !this.activeHigh) ? 1 : 0) << 1) | ((dt ? this.activeHigh : !this.activeHigh) ? 1 : 0);
        this.state = Rotary.grayTable[this.state & 0xf][inputState];

        if ((this.state & 0x30) === Rotary.DIR_CW) {
            this.emit(RotaryDirection.DIR_CW);
        }
        else if ((this.state & 0x30) === Rotary.DIR_CCW) {
            this.emit(RotaryDirection.DIR_CCW);
        }
    }
}

export interface RotaryPinConfig<TPinConfiguration> {
    clk: TPinConfiguration;
    dt: TPinConfiguration;
    sw: TPinConfiguration;
}