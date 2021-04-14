import WebSocket, { Server as WebSocketServer } from 'ws';
import axios from 'axios';
import { Port, ModEffectDefinition } from './models/mod';
import { Rotary, RotaryDirection } from './controllers/rotary';
import { Debouncer } from './controllers/debouncer';
import rpio from 'rpio';
import low from 'lowdb';
import FileSync from 'lowdb/adapters/FileSync';


class ModEffectState {
    id: string;
    uri: string;
    parameters: { [symbol: string]: number }
}

interface Mcp23017PinConfiguration {
    i2cAddress: number,
    bank: 'A' | 'B',
    bit: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
}

interface RotaryPinConfig<TPinConfiguration> {
    clk: TPinConfiguration;
    dt: TPinConfiguration;
    sw: TPinConfiguration;
}

export class ControlBox {

    private modWebsocket: WebSocket;
    private modBoxWebsocket: WebSocketServer;

    private _currentEffectId: string;
    get currentEffectId(): string {
        return this._currentEffectId;
    }
    set currentEffectId(value: string) {
        this._currentEffectId = value;
        this.db.set('["currentEffectId"]', this._currentEffectId).write();
    }

    private rotaryBank = 0;
    private effectList: ModEffectState[] = [];
    private effectDefCache: { [uri: string]: ModEffectDefinition } = {};

    private mcpConfig = [
        {
            interruptPin: 29,
            i2cAddress: 0x20
        }, {
            interruptPin: 31,
            i2cAddress: 0x21
        }
    ];

    private rotaryControls: RotaryPinConfig<Mcp23017PinConfiguration>[] = [{
        clk: { i2cAddress: 0x20, bank: 'B', bit: 3 },
        dt:  { i2cAddress: 0x20, bank: 'B', bit: 4 },
        sw:  { i2cAddress: 0x20, bank: 'B', bit: 5 }
    }, {
        clk: { i2cAddress: 0x20, bank: 'B', bit: 0 },
        dt:  { i2cAddress: 0x20, bank: 'B', bit: 1 },
        sw:  { i2cAddress: 0x20, bank: 'B', bit: 2 }
    }, { 
        clk: { i2cAddress: 0x20, bank: 'A', bit: 3 },
        dt:  { i2cAddress: 0x20, bank: 'A', bit: 4 },
        sw:  { i2cAddress: 0x20, bank: 'A', bit: 5 }
    }, {
        clk: { i2cAddress: 0x20, bank: 'A', bit: 0 },
        dt:  { i2cAddress: 0x20, bank: 'A', bit: 1 },
        sw:  { i2cAddress: 0x20, bank: 'A', bit: 2 }
    }];

    private rotaryControllers: { 
        rotaryController?: Rotary, 
        switchDebouncer?: Debouncer, 
        mode: 'control' | 'edit'
    }[] = [];


    private rotarySelectionControl: RotaryPinConfig<Mcp23017PinConfiguration> = {
        clk: { i2cAddress: 0x21, bank: 'B', bit: 0 },
        dt:  { i2cAddress: 0x21, bank: 'B', bit: 1 },
        sw:  { i2cAddress: 0x21, bank: 'B', bit: 2 }
    };

    private rotarySelectionControlller: {
        rotaryController?: Rotary,
        switchDebouncer?: Debouncer
    } = {};

    private nextBankSelectionControl: Mcp23017PinConfiguration = {
        i2cAddress: 0x21, 
        bank: 'B',
        bit: 3
    };
    
    private prevBankSelectionControl: Mcp23017PinConfiguration = {
        i2cAddress: 0x21,
        bank: 'B',
        bit: 4
    };

    private nextBankSelectionController: Debouncer;
    private prevBankSelectionController: Debouncer;

    private currentEffectParamMap: string[];

    private myWebsocketPort = 8889;
    private websocketConnections: WebSocket[] = [];

    private db: low.LowdbSync<any>;

    constructor(
        private websocketAddress: string,
        private restAddress: string
    ) {
        this.db = low(new FileSync('config.json'));
        if (this.db.has('["currentEffectId"]').value()) {
            this.currentEffectId = this.db.get('["currentEffectId"]').value();
        }

        this.modBoxWebsocket = new WebSocketServer({
            port: this.myWebsocketPort
        });

        this.modBoxWebsocket.on('connection', socket => {
            this.websocketConnections.push(socket);

            socket.send(JSON.stringify({
                activeEffect: this.currentEffect
            }));
        });

        this.modWebsocket = new WebSocket(websocketAddress);
        this.modWebsocket.on('message', data => {
            const [command, ...params] = (data as string).split(' ');
            if (command === 'add') {
                const [graph, uri, x, y] = params;

                if (this.currentEffectId == null) {
                    this.currentEffectId = graph;
                }

                this.effectList.push({
                    id: graph,
                    uri: uri,
                    parameters: {}
                });

                axios.get(`${restAddress}/effect/get?uri=${encodeURIComponent(uri)}`).then(r => {
                    this.effectDefCache[uri] = r.data as ModEffectDefinition;

                    if (this.effectList[0].id === graph) {
                        this.loadEffectParamMap();
                    }
                });
            }
            else if (command === 'param_set') {
                const [id, symbol, value] = params;
                this.effectList.find(effect => effect.id === id).parameters[symbol] = parseFloat(value);
            }
        });

        this.rotarySelectionControlller.rotaryController = new Rotary();
        this.rotarySelectionControlller.rotaryController.on(RotaryDirection.DIR_CW, () => this.advanceCurrentEffect(1));
        this.rotarySelectionControlller.rotaryController.on(RotaryDirection.DIR_CCW, () => this.advanceCurrentEffect(-1));

        this.rotaryControls.forEach((rc, idx) => {
            const r = new Rotary();
            r.on(RotaryDirection.DIR_CW, () => this.rotaryChanged(idx, RotaryDirection.DIR_CW));
            r.on(RotaryDirection.DIR_CCW, () => this.rotaryChanged(idx, RotaryDirection.DIR_CCW));

            const d = new Debouncer();
            d.on(Debouncer.CLICK, () => {
                if (this.rotaryControllers[idx].mode === 'edit') {
                    this.rotaryControllers[idx].mode = 'control';
                    this.db.set(`["rotary_param_map"]["${this.currentEffect.uri}"][${idx}]`, this.currentEffectParamMap[this.rotaryBank * this.rotaryControllers.length + idx]).write();
                    console.log(`Rotary ${idx} mode: ${this.rotaryControllers[idx].mode}, param: ${this.currentEffectParamMap[this.rotaryBank * this.rotaryControllers.length + idx]}`);
                }
            });
            d.on(Debouncer.HELD, () => {
                if (this.rotaryControllers[idx].mode === 'control') {
                    this.rotaryControllers[idx].mode = 'edit';
                    console.log(`Rotary ${idx} mode: ${this.rotaryControllers[idx].mode}`);
                }
            });

            this.rotaryControllers.push({
                rotaryController: r,
                switchDebouncer: d,
                mode: 'control'
            })
        });

        rpio.init({
            mapping: 'physical',
            gpiomem: false
        });

        rpio.i2cBegin();
        rpio.i2cSetBaudRate(100000);

        this.mcpConfig.forEach(config => {

            rpio.open(config.interruptPin, rpio.INPUT, rpio.PULL_DOWN);

            rpio.i2cSetSlaveAddress(config.i2cAddress);

            rpio.i2cWrite(Buffer.from([0x00, 0b11111111])); // IODIRA
            rpio.i2cWrite(Buffer.from([0x02, 0b11111111])); // IOPOLA
            rpio.i2cWrite(Buffer.from([0x04, 0b11111111])); // GPINTENA
            rpio.i2cWrite(Buffer.from([0x0C, 0b11111111])); /// GPUPPA
            
            rpio.i2cWrite(Buffer.from([0x01, 0b11111111])); // IODIRB
            rpio.i2cWrite(Buffer.from([0x03, 0b11111111])); // IOPOLA
            rpio.i2cWrite(Buffer.from([0x05, 0b11111111])); // GPINTENB
            rpio.i2cWrite(Buffer.from([0x0D, 0b11111111])); /// GPUPPB
    
            rpio.i2cWrite(Buffer.from([0x0A, 0 | (1 << 6)])); // IOCON INTERRUPT MIRROR
        })
        
        this.readMcp(29);
        this.readMcp(31);
        
        [29, 31].forEach(pin => rpio.poll(pin, this.readMcp.bind(this)));
    }

    readMcp(pin: number) {
        const pinConfig = this.mcpConfig.find(mc => mc.interruptPin == pin);

        rpio.i2cSetSlaveAddress(pinConfig.i2cAddress);

        const bufferBanks = {
            A: Buffer.alloc(1),
            B: Buffer.alloc(1)
        };

        // BANK A
        rpio.i2cWrite(Buffer.from([0x12]));
        rpio.i2cRead(bufferBanks.A);

        // BANK B
        rpio.i2cWrite(Buffer.from([0x13]));
        rpio.i2cRead(bufferBanks.B)

        // console.log(pin, bufferBanks.A[0].toString(2).padStart(8, '0'), bufferBanks.B[0].toString(2).padStart(8, '0'));

        this.rotaryControls.forEach((rControl, rControlIdx) => {
            if (rControl.clk.i2cAddress == pinConfig.i2cAddress && rControl.dt.i2cAddress === pinConfig.i2cAddress) {
                const clkValue = (bufferBanks[rControl.clk.bank][0] >> rControl.clk.bit & 1) == 1;
                const dtValue = (bufferBanks[rControl.dt.bank][0] >> rControl.dt.bit & 1) == 1;
                this.rotaryControllers[rControlIdx].rotaryController.check(clkValue, dtValue);
            }

            if (rControl.sw.i2cAddress == pinConfig.i2cAddress) {
                const swValue = (bufferBanks[rControl.sw.bank][0] >> rControl.sw.bit & 1) == 1;
                this.rotaryControllers[rControlIdx].switchDebouncer.check(swValue);
            }
        });

        if (pinConfig.i2cAddress === this.rotarySelectionControl.clk.i2cAddress) {
            const clkValue = (bufferBanks[this.rotarySelectionControl.clk.bank][0] >> this.rotarySelectionControl.clk.bit & 1) == 1;
            const dtValue = (bufferBanks[this.rotarySelectionControl.dt.bank][0] >> this.rotarySelectionControl.dt.bit & 1) == 1;
            this.rotarySelectionControlller.rotaryController.check(clkValue, dtValue);
        }
    }

    get currentEffect(): ModEffectState {
        return this.effectList.find(effect => effect.id === this.currentEffectId);
    }

    get currentEffectDef(): ModEffectDefinition {
        return this.effectDefCache[this.effectList.find(effect => effect.id === this.currentEffect.id).uri];
    }

    advanceCurrentEffect(increment: number) {
        this.currentEffectId = this.effectList[this.mod(this.effectList.findIndex(effect => effect.id === this.currentEffectId) + increment, this.effectList.length)].id;

        this.loadEffectParamMap();
        
        this.broadcastWebsocket({
            effect: this.currentEffect,
            paramMap: this.currentEffectParamMap,
            effectBank: this.rotaryBank,
            controlCount: this.rotaryControllers.length
        });
        console.log(this.currentEffectDef.label, this.currentEffectParamMap);
    }

    loadEffectParamMap() {
        const uriEscaped = `["rotary_param_map"]["${this.currentEffect.uri}"]`;
        
        if (!this.db.has(uriEscaped).value()) {
            this.db.set(uriEscaped, this.currentEffectDef?.ports?.control?.input.sort((a, b) => a.index - b.index).map(control => control.symbol)).write();
        }
        this.currentEffectParamMap = this.db.get(uriEscaped).value();
    }

    rotaryChanged(rotaryIndex: number, direction: RotaryDirection) {
        if (this.rotaryControllers[rotaryIndex].mode === 'control') {
            const paramIndex = (this.rotaryBank * this.rotaryControllers.length) + rotaryIndex;
            const currentRotarySymbol = this.currentEffectParamMap.find((param, idx) => idx == paramIndex);
    
            if (currentRotarySymbol != null) {
                const controlPort = this.currentEffectDef?.ports?.control.input.find(control => control.symbol === currentRotarySymbol);
    
                if (controlPort.properties.includes('logarithmic')) {
                    const minLog = Math.log2(controlPort.ranges.minimum);
                    const maxLog = Math.log2(controlPort.ranges.maximum);
                    const stepVal = (maxLog - minLog) / 20.0;
                    const change = stepVal * (direction === RotaryDirection.DIR_CW ? 1 : -1);
                    this.currentEffect.parameters[controlPort.symbol] = Math.pow(2, Math.log2(this.currentEffect.parameters[controlPort.symbol]) + change);
                }
                else if (controlPort.properties.includes('enumeration')) {
                    const currentEnumValue = this.currentEffect.parameters[controlPort.symbol];
                    let newEnumIndex = controlPort.scalePoints.findIndex(sp => sp.value === currentEnumValue) + (direction === RotaryDirection.DIR_CW ? 1 : -1);
                    if (newEnumIndex > controlPort.scalePoints.length - 1) newEnumIndex = controlPort.scalePoints.length - 1;
                    if (newEnumIndex < 0) newEnumIndex = 0;
                    this.currentEffect.parameters[controlPort.symbol] = controlPort.scalePoints[newEnumIndex].value;
                }
                else {
                    const step = (controlPort.ranges?.maximum - controlPort.ranges?.minimum) / 20;
                    this.currentEffect.parameters[controlPort.symbol] += (direction === RotaryDirection.DIR_CW ? 1 : -1) * step;
                }
        
                if (this.currentEffect.parameters[controlPort.symbol] <= controlPort.ranges?.minimum) { this.currentEffect.parameters[controlPort.symbol] = controlPort.ranges?.minimum; }
                if (this.currentEffect.parameters[controlPort.symbol] >= controlPort.ranges?.maximum) { this.currentEffect.parameters[controlPort.symbol] = controlPort.ranges?.maximum; }

                console.log(`param_set ${this.currentEffect.id}/${controlPort.symbol} ${this.currentEffect.parameters[controlPort.symbol]}`);
        
                this.modWebsocket.send(`param_set ${this.currentEffect.id}/${controlPort.symbol} ${this.currentEffect.parameters[controlPort.symbol]}`);
            }
        }
        else {
            const orderedControls = this.currentEffectDef.ports?.control?.input?.sort((a, b) => a.index - b.index);
            const currentControlIdx = orderedControls.findIndex(control => control.symbol === this.currentEffectParamMap[rotaryIndex]);
            this.currentEffectParamMap[rotaryIndex] = orderedControls[this.mod(currentControlIdx + this.rotDirToNum(direction), orderedControls.length)].symbol;
            console.log(`Rotary ${this.rotaryBank * this.rotaryControllers.length + rotaryIndex} (bank ${this.rotaryBank}, phy ${rotaryIndex}): ${this.currentEffectParamMap[rotaryIndex]}`);

        }
    }

    broadcastWebsocket(message: any) {
        this.websocketConnections.forEach(socket => {
            socket.send(JSON.stringify(message));
        })
    }

    rotDirToNum(dir: RotaryDirection): number {
        return dir === RotaryDirection.DIR_CW ? 1 : -1;
    }

    mod(n, m) {
        return ((n % m) + m) % m;
    }
}

const cb = new ControlBox(
    'ws://patchbox:8888/websocket',
    'http://patchbox:8888'
);

console.log('start');