import GPIO from 'rpi-gpio';
import WebSocket from 'ws';
import axios from 'axios';
import { Port, ModEffectDefinition } from './models/mod';
import { Rotary, RotaryDirection } from './controllers/rotary';
import { Debouncer } from './controllers/debouncer';


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


    private rotaryPins = [{ clk: 22, dt: 23}];
    private rotarys: Rotary[] = [];

    private nextPin = 24;
    private nextDebouncer: Debouncer;

    constructor(
        private websocketAddress: string,
        private restAddress: string
    ) {
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

        
        GPIO.setMode(GPIO.MODE_BCM);

        this.rotaryPins.forEach((rp, idx) => {
            const r = new Rotary();
            r.on(RotaryDirection.DIR_CW, () => { this.rotaryChanged(idx, RotaryDirection.DIR_CW); });
            r.on(RotaryDirection.DIR_CCW, () => { this.rotaryChanged(idx, RotaryDirection.DIR_CCW); });
            this.rotarys.push(r);
            
            GPIO.setup(rp.clk, GPIO.DIR_IN, GPIO.EDGE_BOTH, (setupErr) => {
                if (setupErr) throw setupErr;
            });
            GPIO.setup(rp.dt, GPIO.DIR_IN, GPIO.EDGE_BOTH, (setupErr) => {
                if (setupErr) throw setupErr;
            });
        });
        
        this.nextDebouncer = new Debouncer();
        this.nextDebouncer.on('change', (newState: boolean) => {
            if (newState === true) {
                this.currentEffectIndex = (this.currentEffectIndex + 1) % this.effectList.length;
                console.log(this.currentEffectDef.label);
            }
        });

        GPIO.setup(this.nextPin, GPIO.DIR_IN, GPIO.EDGE_BOTH, (setupErr) => {
            if (setupErr) throw setupErr;
        });


        GPIO.on('change', (channel: number, value: boolean) => {
            const rotaryIndex = this.rotaryPins.map(rp => [rp.clk, rp.dt]).findIndex(rp => rp.includes(channel));
            if (rotaryIndex >= 0) {
                const readClkPromise = new Promise<boolean>((resolve, reject) => {
                    GPIO.read(this.rotaryPins[rotaryIndex].clk, (err, value) => err != null ? reject(err.message) : resolve(value));
                });
                const readDtPromise = new Promise<boolean>((resolve, reject) => {
                    GPIO.read(this.rotaryPins[rotaryIndex].dt, (err, value) => err != null ? reject(err.message) : resolve(value));
                });

                Promise.all([readClkPromise, readDtPromise]).then(readResults => {
                    const [clk, dt] = readResults;
                    this.rotarys[rotaryIndex].check(clk, dt);
                })
            }
            if (channel == this.nextPin) {
                this.nextDebouncer.check(value);
            }
        });
    }

    get currentEffect(): ModEffectState {
        return this.effectList[this.currentEffectIndex % this.effectList.length]
    }

    get currentEffectDef(): ModEffectDefinition {
        return this.effectDefCache[this.effectList.find(effect => effect.id === this.currentEffect.id).uri];
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