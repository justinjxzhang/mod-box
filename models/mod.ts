export interface Port {
    name: string;
    shortName: string;
    symbol: string;
    index: number;
    ranges?: {
        minimum?: number;
        maximum?: number;
        default?: number;
    };
    units?: {
        label?: string;
        render?: string;
        symbol?: string;
    }
    properties: string[];
}

export interface ModEffectDefinition {
    author?: {
     email?: string;
     homepage?: string;
     name?: string;
    };
    binary: string;
    brand: string;
    comment?: string;
    label: string;
    ports?: {
        audio?: {
            input: Port[],
            output: Port[],

        },
        control?: {
            input: Port[],
            output: Port[],
        }
    }
}