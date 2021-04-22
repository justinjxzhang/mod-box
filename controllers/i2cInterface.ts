export interface I2CInterface {
    write: (address: number, buffer: number[]) => void;
    read: (address: number, length: number) => number[];
}
