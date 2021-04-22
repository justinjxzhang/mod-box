import WebSocket from 'ws';
import axios from 'axios';
import rpio from 'rpio';
import low from 'lowdb';
import FileSync from 'lowdb/adapters/FileSync';
import * as oledfont5x7 from 'oled-font-5x7';

import { Port, ModEffectDefinition } from './models/mod';
import { Rotary, RotaryDirection, RotaryPinConfig } from './controllers/rotary';
import { Debouncer } from './controllers/debouncer';
import { Mcp23017PinConfiguration } from './models/mcp23017';
import { I2CInterface } from './controllers/i2cInterface';
import { RpioI2c } from './controllers/rpioI2c';
import { Utils } from './utils';
import { OledPlus } from './controllers/oledPlus';
import { TCA9548A } from './controllers/tca9548a';

class ModEffectState {
    id: string;
    uri: string;
    parameters: { [symbol: string]: number }
}

class OverviewScreen {
    constructor(
        public oled: OledPlus
    ) { 
        this.oled.clearDisplay(false);
        this.update();
    }

    update() {
        this.oled.update();
    }

    drawEffectList(effectList: string[], selectedEffect: string): void {
        this.oled.clearDisplay(false);
        this.oled.setCursor(0, 0);
        this.oled.drawList(0, 0, 6, effectList, selectedEffect, e => e, (a, b) => a === b);
    }
}

export class ControlBox {

    private modWebsocket: WebSocket;

    private db: low.LowdbSync<any>;

    private iicInterface: I2CInterface;
    private tca: TCA9548A;

    private _currentEffectId: string;
    get currentEffectId(): string { return this._currentEffectId; }
    set currentEffectId(value: string) { this._currentEffectId = value; this.db.set('["currentEffectId"]', this._currentEffectId).write(); }

    get currentEffect(): ModEffectState { return this.effectList.find(effect => effect.id === this.currentEffectId); }
    get currentEffectDef(): ModEffectDefinition { return this.effectDefCache[this.effectList.find(effect => effect.id === this.currentEffect.id).uri]; }

    private rotaryBank = 0;
    private effectList: ModEffectState[] = [];
    private effectDefCache: { [uri: string]: ModEffectDefinition } = {};

    private mcpConfig = [
        { interruptPin: 29, i2cAddress: 0x20 }, 
        { interruptPin: 31, i2cAddress: 0x21 }
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

    private rotaryEffectSelectionControl: RotaryPinConfig<Mcp23017PinConfiguration> = {
        clk: { i2cAddress: 0x21, bank: 'B', bit: 0 },
        dt:  { i2cAddress: 0x21, bank: 'B', bit: 1 },
        sw:  { i2cAddress: 0x21, bank: 'B', bit: 2 }
    };

    private rotaryControllers: { 
        rotaryController?: Rotary, 
        switchDebouncer?: Debouncer, 
        mode: 'control' | 'edit'
    }[] = [];

    private rotarySelectionControlller: {
        rotaryController?: Rotary,
        switchDebouncer?: Debouncer
    } = {};

    private currentEffectParamMap: string[];

    // OLEDS

    private controlOleds: {
        oled: OledPlus
    }[] = [];

    private overviewOled: OverviewScreen;

    // Timeout references

    private startup: {
        completed: boolean,
        timeout?: NodeJS.Timeout
    } = {
        completed: false
    };
    
    private controlUpdateTimeout: NodeJS.Timeout;

    constructor(
        private websocketAddress: string,
        private restAddress: string
    ) {

        //#region Database setup
        this.db = low(new FileSync('config.json'));
        if (this.db.has('["currentEffectId"]').value()) {
            this.currentEffectId = this.db.get('["currentEffectId"]').value();
        }
        //#endregion


        //#region mod-ui websocket
        this.modWebsocket = new WebSocket(websocketAddress);
        this.modWebsocket.on('message', data => this.handleModWebsocketMessage(data));
        //#endregion

        //#region rpio configuration and physical 
        rpio.init({ mapping: 'physical', gpiomem: false });
        rpio.i2cBegin();
        rpio.i2cSetBaudRate(400000);

        this.iicInterface = new RpioI2c(rpio);
        this.tca = new TCA9548A(0x70, this.iicInterface);

        this.mcpConfig.forEach(config => {

            rpio.open(config.interruptPin, rpio.INPUT, rpio.PULL_DOWN);
 
            this.iicInterface.write(config.i2cAddress, [0x00, 0b11111111]); // IODIRA
            this.iicInterface.write(config.i2cAddress, [0x02, 0b11111111]); // IOPOLA
            this.iicInterface.write(config.i2cAddress, [0x04, 0b11111111]); // GPINTENA
            this.iicInterface.write(config.i2cAddress, [0x0C, 0b11111111]); // GPUPPA

            this.iicInterface.write(config.i2cAddress, [0x01, 0b11111111]); // IODIRB
            this.iicInterface.write(config.i2cAddress, [0x03, 0b11111111]); // IOPOLA
            this.iicInterface.write(config.i2cAddress, [0x05, 0b11111111]); // GPINTENB
            this.iicInterface.write(config.i2cAddress, [0x0D, 0b11111111]); // GPUPPB

            this.iicInterface.write(config.i2cAddress, [0x0A, 0 | (1 << 6)]); // IOCON INTERRUPT MIRROR
        });
        //#endregion


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
                    
                    const currentPort = this.currentEffectDef.ports.control.input.find(p => p.symbol === this.currentEffectParamMap[idx]);
                    const currentValue = this.currentEffect.parameters[this.currentEffectParamMap[idx]];

                    if (idx < this.controlOleds.length) {
                    
                        this.controlOleds[idx].oled.clearDisplay();
                        this.controlOleds[idx].oled.setCursor(0, 0);
                        if (currentPort != null) {
                            this.controlOleds[idx].oled.writeString(oledfont5x7, 1, currentPort.name ?? "", 0x01, false, 1, false);
                            this.drawCurrentValueByIndex(idx);
                        }
    
                        this.controlOleds[idx].oled.update();
                    }

                    console.log(`Rotary ${idx} mode: ${this.rotaryControllers[idx].mode}, param: ${this.currentEffectParamMap[this.rotaryBank * this.rotaryControllers.length + idx]}`);
                }
            });
            d.on(Debouncer.HELD, () => {
                if (this.rotaryControllers[idx].mode === 'control') {
                    this.rotaryControllers[idx].mode = 'edit';

                    if (idx < this.controlOleds.length) {
                        this.drawPortSelectMenu(idx);
                        this.controlOleds[idx].oled.update();
                    }

                    console.log(`Rotary ${idx} mode: ${this.rotaryControllers[idx].mode}`);
                }
            });

            this.rotaryControllers.push({
                rotaryController: r,
                switchDebouncer: d,
                mode: 'control'
            })
        });

        this.mcpConfig.forEach(config => {
            this.readMcp(config.interruptPin);
            rpio.poll(config.interruptPin, this.readMcp.bind(this))
        })


        //#region oled configuration
        this.controlOleds = [2, 3, 4, 5].map(port => {

            const currOled = new OledPlus(
                (address, dataArray) => {
                    this.tca.selectRegister(port);
                    this.iicInterface.write(address, dataArray);
                },
                (address) => {
                    this.tca.selectRegister(port);
                    return this.iicInterface.read(address, 1)[0];
                },
                {
                    address: 0x3c,
                    height: 64,
                    width:128
                }
            );

            currOled.turnOnDisplay();
            currOled.clearDisplay()
            currOled.update();

            return {
                oled: currOled
            };
        });

        this.overviewOled = new OverviewScreen(
            new OledPlus(
                (address, dataArray) => {
                    this.tca.selectRegister(7);
                    this.iicInterface.write(address, dataArray);
                },
                (address) => {
                    this.tca.selectRegister(7);
                    return this.iicInterface.read(address, 1)[0];
                }, {
                    address: 0x3c, height:64, width: 128
                }
            )
        );
        //#endregion
    }

    readMcp(pin: number) {
        const pinConfig = this.mcpConfig.find(mc => mc.interruptPin == pin);

        const bufferBanks = {
            A: [],
            B: []
        }

        // BANK A
        this.iicInterface.write(pinConfig.i2cAddress, [0x12]);
        bufferBanks.A = this.iicInterface.read(pinConfig.i2cAddress, 1);


        // BANK B
        this.iicInterface.write(pinConfig.i2cAddress, [0x13]);
        bufferBanks.B = this.iicInterface.read(pinConfig.i2cAddress, 1);

        this.rotaryControls.forEach((rControl, rControlIdx) => {
            if (rControl.clk.i2cAddress == pinConfig.i2cAddress && rControl.dt.i2cAddress === pinConfig.i2cAddress) {
                const clkValue = (bufferBanks[rControl.clk.bank][0] >> rControl.clk.bit & 1) == 1;
                const dtValue = (bufferBanks[rControl.dt.bank][0] >> rControl.dt.bit & 1) == 1;
                this.rotaryControllers[rControlIdx]?.rotaryController.check(clkValue, dtValue);
            }

            if (rControl.sw.i2cAddress == pinConfig.i2cAddress) {
                const swValue = (bufferBanks[rControl.sw.bank][0] >> rControl.sw.bit & 1) == 1;
                this.rotaryControllers[rControlIdx]?.switchDebouncer.check(swValue);
            }
        });

        if (pinConfig.i2cAddress === this.rotaryEffectSelectionControl.clk.i2cAddress) {
            const clkValue = (bufferBanks[this.rotaryEffectSelectionControl.clk.bank][0] >> this.rotaryEffectSelectionControl.clk.bit & 1) == 1;
            const dtValue = (bufferBanks[this.rotaryEffectSelectionControl.dt.bank][0] >> this.rotaryEffectSelectionControl.dt.bit & 1) == 1;
            this.rotarySelectionControlller?.rotaryController.check(clkValue, dtValue);
        }
    }

    updateMainOled() {
        this.overviewOled.drawEffectList(this.effectList.map(e => this.effectDefCache[e.uri].label), this.effectDefCache[this.currentEffect.uri].label);
        this.overviewOled.update();
    }

    advanceCurrentEffect(increment: number) {
        this.currentEffectId = this.effectList[Utils.mod(this.effectList.findIndex(effect => effect.id === this.currentEffectId) + increment, this.effectList.length)].id;

        this.loadEffectParamMap();

        this.updateMainOled();

        if (this.controlUpdateTimeout != null) clearTimeout(this.controlUpdateTimeout);
        this.controlUpdateTimeout = setTimeout(() => {
            this.controlOleds.forEach((oledConfig, idx) => {
                if (idx < this.currentEffectParamMap.length) {
                    const currentPort = this.currentEffectDef.ports.control.input.find(p => p.symbol === this.currentEffectParamMap[idx]);
                    oledConfig.oled.clearDisplay(false);
                    if (currentPort != null) {
                        oledConfig.oled.setCursor(0, 0);
                        oledConfig.oled.writeString(oledfont5x7, 1, currentPort.name, 0x01, true, 1, false);
                        this.drawCurrentValueByIndex(idx);
                    }
                }
                else {
                    oledConfig.oled.clearDisplay();
                }
                oledConfig.oled.update();
            });
        }, 750);

        console.log(this.currentEffectDef.label, this.currentEffectParamMap);
    }

    calculatePortProportion(currentValue: number, portDef: Port): number {
        const { minimum, maximum } = portDef.ranges;
        if (portDef.properties.includes('logarithmic')) {
            const minLog = Math.log2(minimum);
            const maxLog = Math.log2(maximum);
            const currentLog = Math.log2(currentValue);
            return (currentLog - minLog) / (maxLog - minLog);
        }
        else {
            return (currentValue - minimum) / (maximum - minimum)
        }
    }

    drawCurrentValue(oled: OledPlus, currentValue: number, portDef: Port) {
        if (portDef.properties.includes('enumeration')) {
            oled.drawList(0, 30, 3, portDef.scalePoints, currentValue, sp => sp.label, (a, b) => a.value === b);
        } else {
            oled.fillRect(1, 51, 125, 12, 0x00, false);
            oled.drawRect(0, 50, 127, 14, 0x01, false);
            oled.fillRect(2, 52, (127 * this.calculatePortProportion(currentValue, portDef)), 10, 0x01, false);

            // Draw ticks
            oled.drawLine(0, 45, 0, 50, 0x01, false);
            oled.drawLine(127, 45, 127, 50, 0x01, false);
            oled.drawLine(64, 45, 64, 50, 0x01, false);
        }
    }

    drawCurrentValueByIndex(controlIndex: number) {
        const bankIndex = (this.rotaryBank * this.rotaryControls.length) + controlIndex;
        const symbol = this.currentEffectParamMap[bankIndex];

        const currentValue = this.currentEffect.parameters[symbol];
        const portDef = this.currentEffectDef.ports.control.input.find(c => c.symbol === symbol);

        if (controlIndex < this.controlOleds.length) {
            this.drawCurrentValue(
                this.controlOleds[controlIndex].oled,
                currentValue,
                portDef
            );
        }
    }

    drawPortSelectMenu(controlIdx: number) {
        const currOled = this.controlOleds[controlIdx].oled;
        currOled.clearDisplay();
        currOled.setCursor(0, 0);
        currOled.writeString(oledfont5x7, 1, this.currentEffectDef.label, 0x01, false, 1, false);
        currOled.drawLine(0, 9, 127, 9, 0x01, false);
        
        currOled.drawList(
            0, 
            11, 
            4, 
            [null, ...this.currentEffectDef.ports.control.input], 
            this.currentEffectParamMap[controlIdx],
            (v) => v?.name ?? '-- Clear --',
            (a, b) => a?.symbol == b
        );
    }

    loadEffectParamMap() {
        console.log(this._currentEffectId, this.effectList.map(e => e.id));
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

                if(this.controlOleds.length > rotaryIndex) {
                    this.drawCurrentValueByIndex(rotaryIndex);
                    this.controlOleds[rotaryIndex].oled.update();
                }

                console.log(`param_set ${this.currentEffect.id}/${controlPort.symbol} ${this.currentEffect.parameters[controlPort.symbol]}`);
        
                this.modWebsocket.send(`param_set ${this.currentEffect.id}/${controlPort.symbol} ${this.currentEffect.parameters[controlPort.symbol]}`);
            }
        }
        else {
            const orderedControls = [null, ...this.currentEffectDef.ports?.control?.input?.sort((a, b) => a.index - b.index)];
            const currentControlIdx = orderedControls.findIndex(control => control?.symbol == this.currentEffectParamMap[rotaryIndex]);
            this.currentEffectParamMap[rotaryIndex] = orderedControls[Utils.mod(currentControlIdx + this.rotDirToNum(direction), orderedControls.length)]?.symbol;
            if (this.controlOleds.length > rotaryIndex) {
                this.drawPortSelectMenu(rotaryIndex);
                this.controlOleds[rotaryIndex].oled.update();
            }
            console.log(`Rotary ${this.rotaryBank * this.rotaryControllers.length + rotaryIndex} (bank ${this.rotaryBank}, phy ${rotaryIndex}): ${this.currentEffectParamMap[rotaryIndex] ?? 'nothing'}`);

        }
    }

    rotDirToNum(dir: RotaryDirection): number {
        return dir === RotaryDirection.DIR_CW ? 1 : -1;
    }

    handleModWebsocketMessage(data: WebSocket.Data) {
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

            if (!(uri in this.effectDefCache)) {
                axios.get(`${this.restAddress}/effect/get?uri=${encodeURIComponent(uri)}`).then(r => {
                    this.effectDefCache[uri] = r.data as ModEffectDefinition;
                }, rej => {
                    console.log(rej);
                });
            }
        }
        else if (command === 'param_set') {
            const [id, symbol, value] = params;
            this.effectList.find(effect => effect.id === id).parameters[symbol] = parseFloat(value);
            if (this.currentEffect?.id === id) {
                const paramIdx = this.currentEffectParamMap?.findIndex(param => param === symbol);
                if (paramIdx >= 0 && paramIdx >= this.rotaryControls.length * this.rotaryBank && paramIdx < this.rotaryControls.length * this.rotaryBank + this.rotaryControls.length) {
                    const bankedOledIdx = Utils.mod(paramIdx, this.rotaryControls.length);
                    if (this.controlOleds.length > bankedOledIdx)
                    {
                        this.drawCurrentValue(
                            this.controlOleds[bankedOledIdx].oled,
                            this.currentEffect.parameters[symbol],
                            this.currentEffectDef.ports.control.input.find(c => c.symbol === symbol)
                        );
                        this.controlOleds[bankedOledIdx].oled.update();
                    }
                }
            }
        }
        else if (command === 'remove') {
            const [id] = params;
            if (id == ':all') { 
                this.effectList = [];
            }
            else {
                if (this.currentEffect.id === id) {
                    this.advanceCurrentEffect(1);
                }
                this.effectList = this.effectList.filter(e => e.id != id);
            }
        }

        if (!this.startup.completed && !['stats', 'ping', 'sys_stats'].includes(command)) {
            if (this.startup.timeout != null) {
                clearTimeout(this.startup.timeout);
            }
            this.startup.timeout = setTimeout(() => {
                if (!this.effectList.map(e => e.id).includes(this.currentEffectId)) {
                    this.currentEffectId = this.effectList[0].id;
                }
                this.loadEffectParamMap();
                this.controlOleds.forEach((oledConfig, oledIndex) => {
                    oledConfig.oled.setCursor(0, 0);
                    const currentPort = this.currentEffectDef.ports.control.input.find(p => p.symbol === this.currentEffectParamMap[oledIndex]);
                    if (currentPort != null) {
                        oledConfig.oled.writeString(oledfont5x7, 1, currentPort.name ?? "", 0x01, false, 1, false);
                        this.drawCurrentValueByIndex(oledIndex);
                        oledConfig.oled.update();
                    }
                });

                this.updateMainOled();

                this.startup.completed = true;
            }, 1000);
        }
    }
}

const cb = new ControlBox(
    'ws://patchbox:8888/websocket',
    'http://patchbox:8888'
);

console.log('start');