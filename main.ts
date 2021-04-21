import WebSocket, { Server as WebSocketServer } from 'ws';
import axios from 'axios';
import { Port, ModEffectDefinition } from './models/mod';
import { Rotary, RotaryDirection } from './controllers/rotary';
import { Debouncer } from './controllers/debouncer';
import rpio from 'rpio';
import low from 'lowdb';
import FileSync from 'lowdb/adapters/FileSync';
import Oled from '../oled-js/oled';
import * as oledfont5x7 from 'oled-font-5x7';

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

interface I2CInterface {
    write: (address: number, buffer: number[]) => void;
    read: (address: number, length: number) => number[];
}

class RpioI2cInterface implements I2CInterface {
    private rpioInstance: Rpio;

    constructor(rpioInstance: Rpio) {
        this.rpioInstance = rpioInstance;
    }

    write(address: number, buffer: number[]) {
        this.rpioInstance.i2cSetSlaveAddress(address);
        this.rpioInstance.i2cWrite(Buffer.from(buffer));
    }

    read(address: number, length: number): number[] {
        this.rpioInstance.i2cSetSlaveAddress(address);
        const readBuf = Buffer.alloc(length);
        this.rpioInstance.i2cRead(readBuf);
        return [...readBuf];
    }
}

class TCA9548A {
    private currentRegister: number;

    constructor(
        private address: number,
        private iicInterface: I2CInterface
    ) { }

    selectRegister(register: number) {
        if (this.currentRegister != register) {
            this.iicInterface.write(this.address, [(1 << register)]);
            this.currentRegister = register;
        }
    }
}

export class ControlBox {

    // private startupDataLoaded: NodeJS.Timeout;
    private startup: {
        completed: boolean,
        timeout?: NodeJS.Timeout
    } = {
        completed: false
    };

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

    private iicInterface: I2CInterface;
    private tca9584a: TCA9548A;

    private controlOleds: { 
        tcaPort: number,
        oled: Oled
    }[] = [];

    private mainOled: {
        tcaPort: number;
        oled: Oled
    };

    private controlUpdateTimeout: NodeJS.Timeout;

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

                    // if (this.effectList[0].id === graph) {
                    //     this.loadEffectParamMap();
                    // }
                }, rej => {
                    console.log(rej);
                });
            }
            else if (command === 'param_set') {
                const [id, symbol, value] = params;
                this.effectList.find(effect => effect.id === id).parameters[symbol] = parseFloat(value);
                if (this.currentEffect?.id === id) {
                    const paramIdx = this.currentEffectParamMap?.findIndex(param => param === symbol);
                    if (paramIdx >= 0 && paramIdx >= this.rotaryControls.length * this.rotaryBank && paramIdx < this.rotaryControls.length * this.rotaryBank + this.rotaryControls.length) {
                        const bankedOledIdx = this.mod(paramIdx, this.rotaryControls.length);
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
                    this.startup.completed = true;
                }, 1000);
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
                    
                    // const currOled = this.controlOleds[idx].oled;
                    // currOled.clearDisplay();
                    // currOled.setCursor(0, 0);
                    // currOled.writeString(oledfont5x7, 1, this.currentEffectDef.label, 0x01, false, 1, false);
                    // currOled.drawLine(0, 9, 127, 9, 0x01, false);

                    // this.currentEffectDef.ports.control.input.forEach((inputControl, portIdx) => {
                    //     currOled.setCursor(0, (10 * portIdx) + 11);
                    //     currOled.writeString(oledfont5x7, 1, `${this.currentEffectParamMap[idx] === inputControl.symbol ? "* " :  "  "}${inputControl.name}`, 0x01, false, 1, false);
                    //     currOled.update();
                    // });

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

        rpio.init({
            mapping: 'physical',
            gpiomem: false
        });

        rpio.i2cBegin();
        rpio.i2cSetBaudRate(400000);

        this.iicInterface = new RpioI2cInterface(rpio);
        this.tca9584a = new TCA9548A(0x70, this.iicInterface);

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

        this.mcpConfig.forEach(conf => {
            this.readMcp(conf.interruptPin);
            rpio.poll(conf.interruptPin, this.readMcp.bind(this))
        });

        this.controlOleds = [2, 3, 4, 5].map(port => {

            const currOled = new Oled(
                (address, dataArray) => {
                    this.tca9584a.selectRegister(port);
                    rpio.i2cSetSlaveAddress(address);
                    rpio.i2cWrite(Buffer.from(dataArray));
                },
                (address) => {
                    rpio.i2cSetSlaveAddress(address);
                    const readBuf = Buffer.alloc(1);
                    rpio.i2cRead(readBuf);
                    return readBuf[0];
                },
                {
                    address: 0x3c,
                    height: 64,
                    width:128
                }
            );

            currOled.turnOnDisplay();
            currOled.fillRect(0, 0, 128, 64, 0x00, true);

            return {
                tcaPort: port,
                oled: currOled
            };
        });

        this.mainOled = {
            oled: new Oled(
                (address, dataArray) => {
                    this.tca9584a.selectRegister(7);
                    rpio.i2cSetSlaveAddress(address);
                    rpio.i2cWrite(Buffer.from(dataArray));
                },
                (address) => {
                    this.tca9584a.selectRegister(7);
                    rpio.i2cSetSlaveAddress(address);
                    const readBuf = Buffer.alloc(1);
                    rpio.i2cRead(readBuf);
                    return readBuf[0];
                },
                {
                    address: 0x3c,
                    height: 64,
                    width:128
                }
            ),
            tcaPort: 7
        };

        this.mainOled.oled.turnOnDisplay();
        this.mainOled.oled.fillRect(0, 0, 128, 64, 0x00, true);
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

        this.mainOled.oled.clearDisplay(false);
        this.mainOled.oled.setCursor(0, 0);

        this.drawList(this.mainOled.oled, 0, 0, 6, this.effectList, this.currentEffectId, e => this.effectDefCache[e.uri].label, (a, b) => a.id === b);
        this.mainOled.oled.update();

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

    drawCurrentValue(oled: Oled, currentValue: number, portDef: Port) {
        if (portDef.properties.includes('enumeration')) {
            this.drawList(oled, 0, 30, 3, portDef.scalePoints, currentValue, sp => sp.label, (a, b) => a.value === b);
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

    drawList<T1, T2>(oled: Oled, x: number, y: number, itemsPerPage: number, items: T1[], selected: T2, nameGetter: (v: T1) => string, compare: (a: T1, b: T2) => boolean) {
        const selectedIndex = items.findIndex(i => compare(i, selected));
        const selectedIndexPage = this.mod(selectedIndex, itemsPerPage);
        const currentPage = Math.floor(selectedIndex / itemsPerPage);
        const pageItems = items.filter((item, index) => index >= itemsPerPage * currentPage && index < itemsPerPage * currentPage + itemsPerPage);

        oled.fillRect(x, y, 128, itemsPerPage * 10, 0x00, false);

        oled.setCursor(x, y);
        pageItems.forEach((pageItem, idx) => {
            const displayString = `${idx === selectedIndexPage ? '* ' : '  '}${nameGetter(pageItem)}`;
            oled.setCursor(x, (idx * 10) + y);
            oled.writeString(oledfont5x7, 1, displayString, 0x01, false, 1, false);
        });
    }

    drawPortSelectMenu(controlIdx: number) {
        const currOled = this.controlOleds[controlIdx].oled;
        currOled.clearDisplay();
        currOled.setCursor(0, 0);
        currOled.writeString(oledfont5x7, 1, this.currentEffectDef.label, 0x01, false, 1, false);
        currOled.drawLine(0, 9, 127, 9, 0x01, false);
        
        this.drawList(
            currOled, 
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
            this.currentEffectParamMap[rotaryIndex] = orderedControls[this.mod(currentControlIdx + this.rotDirToNum(direction), orderedControls.length)]?.symbol;
            if (this.controlOleds.length > rotaryIndex) {
                this.drawPortSelectMenu(rotaryIndex);
                this.controlOleds[rotaryIndex].oled.update();
            }
            console.log(`Rotary ${this.rotaryBank * this.rotaryControllers.length + rotaryIndex} (bank ${this.rotaryBank}, phy ${rotaryIndex}): ${this.currentEffectParamMap[rotaryIndex] ?? 'nothing'}`);

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