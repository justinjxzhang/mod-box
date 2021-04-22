export interface Mcp23017PinConfiguration {
    i2cAddress: number,
    bank: 'A' | 'B',
    bit: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
}