import { I2CInterface } from "./i2cInterface";

export class RpioI2c implements I2CInterface {
    private rpioInstance: Rpio;
    private currentSlaveAddress: number;

    constructor(rpioInstance: Rpio) {
        this.rpioInstance = rpioInstance;
    }

    private setSlaveAddress(address: number) {
        if (this.currentSlaveAddress != address) {
            this.rpioInstance.i2cSetSlaveAddress(address);
            this.currentSlaveAddress = address;
        }
    }

    write(address: number, buffer: number[]) {
        this.setSlaveAddress(address);
        this.rpioInstance.i2cWrite(Buffer.from(buffer));
    }

    read(address: number, length: number): number[] {
        this.setSlaveAddress(address);
        const readBuf = Buffer.alloc(length);
        this.rpioInstance.i2cRead(readBuf);
        return [...readBuf];
    }
}