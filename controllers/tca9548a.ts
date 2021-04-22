import { I2CInterface } from "./i2cInterface";

export class TCA9548A {
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