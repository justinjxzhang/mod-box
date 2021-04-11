import WebSocket from 'ws';
import axios from 'axios';
import { Port, ModEffectDefinition } from './models/mod';
import { Rotary, RotaryDirection } from './controllers/rotary';
import { Debouncer } from './controllers/debouncer';
import rpio from 'rpio';


class ModEffectState {
    id: string;
    uri: string;
    parameters: { [symbol: string]: number }
}

export class ControlBox {

    private ws: WebSocket;

    private currentEffectIndex = 0;
    private effectList: ModEffectState[] = [];
    private effectDefCache: { [uri: string]: ModEffectDefinition } = {};

    private mcpPins = {
        interrupt: {
            a: 29,
            b: 31
        },
    }


    // private rotaryPins = [{ clk: 22, dt: 23}];

    private rotaryPins = [{
        clk: { bank: 'b', pin: 2 }, 
        dt:  { bank: 'b', pin: 1 }
    }, {
        clk: { bank: 'a', pin: 2 },
        dt:  { bank: 'a', pin: 1 }
    }, {
        clk: { bank: 'a', pin: 5 },
        dt:  { bank: 'a', pin: 4 }
    }];


    private rotarys: Rotary[] = [];

    private nextPin = 29;
    private nextDebouncer: Debouncer;
    private previousDebouncer: Debouncer;

    constructor(
        private websocketAddress: string,
        private restAddress: string
    ) {
        rpio.init({
            mapping: 'physical',
            gpiomem: false
        });
        rpio.i2cBegin();
        rpio.i2cSetSlaveAddress(0x20);
        rpio.i2cSetBaudRate(100000);

        this.ws = new WebSocket(websocketAddress);
        this.ws.on('message', data => {
            const [command, ...params] = (data as string).split(' ');
            if (command === 'add') {
                const [graph, uri, x, y] = params;
                axios.get(`${restAddress}/effect/get?uri=${encodeURIComponent(uri)}`).then(r => {
                    this.effectDefCache[uri] = r.data as ModEffectDefinition;
                });

                this.effectList.push({
                    id: graph,
                    uri: uri,
                    parameters: {}
                });
            }
            else if (command === 'param_set') {
                const [id, symbol, value] = params;
                this.effectList.find(effect => effect.id === id).parameters[symbol] = parseFloat(value);
            }
        });
        
        this.nextDebouncer = new Debouncer();
        this.previousDebouncer = new Debouncer();
        this.nextDebouncer.on('change', (newState: boolean) => {
            if (newState === true) {
                this.incrementCurrentEffectIndex(1);
            }
        });
        this.previousDebouncer.on('change', (newState: boolean) => {
            if (newState === true) {
                this.incrementCurrentEffectIndex(-1);
            }
        });

        this.rotaryPins.forEach((rp, idx) => {
            const r = new Rotary();
            r.on(RotaryDirection.DIR_CW, () => this.rotaryChanged(idx, RotaryDirection.DIR_CW));
            r.on(RotaryDirection.DIR_CCW, () => this.rotaryChanged(idx, RotaryDirection.DIR_CCW));
            this.rotarys.push(r);
        })

        rpio.open(this.mcpPins.interrupt.a, rpio.INPUT, rpio.PULL_DOWN);
        rpio.open(this.mcpPins.interrupt.b, rpio.INPUT, rpio.PULL_DOWN);

        rpio.i2cWrite(Buffer.from([0x00, 0b11111111])); // IODIRA
        rpio.i2cWrite(Buffer.from([0x02, 0b11111111])); // IOPOLA
        rpio.i2cWrite(Buffer.from([0x04, 0b11111111])); // GPINTENA
        rpio.i2cWrite(Buffer.from([0x0C, 0b11111111])); /// GPUPPA

        
        rpio.i2cWrite(Buffer.from([0x01, 0b11111111])); // IODIRB
        rpio.i2cWrite(Buffer.from([0x03, 0b11111111])); // IOPOLA
        rpio.i2cWrite(Buffer.from([0x05, 0b11111111])); // GPINTENB
        rpio.i2cWrite(Buffer.from([0x0D, 0b11111111])); /// GPUPPB

        this.readMcp(31);
        
        [29, 31].forEach(pin => rpio.poll(pin, this.readMcp.bind(this)));
    }

    readMcp(pin: number) {
        // BANK A
        rpio.i2cWrite(Buffer.from([0x12]));
        let aBuffer = Buffer.alloc(1);
        rpio.i2cRead(aBuffer);

        // BANK B
        rpio.i2cWrite(Buffer.from([0x13]));
        let bBuffer = Buffer.alloc(1);
        rpio.i2cRead(bBuffer)
        // console.log(pin, aBuffer[0].toString(2), bBuffer[0].toString(2), aBuffer[0] >> 7 & 1);

        this.nextDebouncer.check((aBuffer[0] >> 7 & 1) === 1);
        this.previousDebouncer.check((aBuffer[0] >> 6 & 1) === 1);

        this.rotaryPins.forEach((rp, idx) => {
            const clkValue = ((rp.clk.bank === 'a' ? aBuffer[0] : bBuffer[0]) >> rp.clk.pin & 1) === 1;
            const dtValue = ((rp.dt.bank === 'a' ? aBuffer[0] : bBuffer[0]) >> rp.dt.pin & 1) === 1;

            this.rotarys[idx].check(clkValue, dtValue);
        })

    }

    get currentEffect(): ModEffectState {
        return this.effectList[this.currentEffectIndex % this.effectList.length]
    }

    get currentEffectDef(): ModEffectDefinition {
        return this.effectDefCache[this.effectList.find(effect => effect.id === this.currentEffect.id).uri];
    }

    incrementCurrentEffectIndex(increment: number) {
        this.currentEffectIndex = (this.currentEffectIndex + increment) % this.effectList.length;
        console.log(this.currentEffectDef.label);
    }

    rotaryChanged(index: number, direction: RotaryDirection) {
        const controlPort = this.currentEffectDef?.ports?.control.input.sort((a, b) => a.index - b.index)[index];

        console.log(
            this.currentEffectDef.label, 
            this.currentEffectDef.ports.control.input[index].symbol
        );

        if (controlPort.properties.includes('logarithmic')) {
            const minLog = Math.log2(controlPort.ranges.minimum);
            const maxLog = Math.log2(controlPort.ranges.maximum);
            const stepVal = (maxLog - minLog) / 20.0;
            const change = stepVal * (direction === RotaryDirection.DIR_CW ? 1 : -1);
            this.currentEffect.parameters[controlPort.symbol] = Math.pow(2, Math.log2(this.currentEffect.parameters[controlPort.symbol]) + change);
        }
        else {
            const step = (controlPort.ranges?.maximum - controlPort.ranges?.minimum) / 20;
            this.currentEffect.parameters[controlPort.symbol] += (direction === RotaryDirection.DIR_CW ? 1 : -1) * step;
        }

        if (this.currentEffect.parameters[controlPort.symbol] <= controlPort.ranges?.minimum) { this.currentEffect.parameters[controlPort.symbol] = controlPort.ranges?.minimum; }
        if (this.currentEffect.parameters[controlPort.symbol] >= controlPort.ranges?.maximum) { this.currentEffect.parameters[controlPort.symbol] = controlPort.ranges?.maximum; }

        this.ws.send(`param_set ${this.currentEffect.id}/${controlPort.symbol} ${this.currentEffect.parameters[controlPort.symbol]}`);
    }
}

const cb = new ControlBox(
    'ws://patchbox:8888/websocket',
    'http://patchbox:8888'
);

console.log('start');