/**
 * Spinner Component
 * 
 * Animated spinner using braille characters.
 * Pulses to show the agent is alive and working.
 */

import { useEffect, useState } from 'react';
import { Text } from 'ink';

// Braille spinner frames
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface SpinnerProps {
    color?: string;
    speed?: number;
}

export function Spinner({ color = '#d29922', speed = 80 }: SpinnerProps) {
    const [frame, setFrame] = useState(0);

    useEffect(() => {
        const interval = setInterval(() => {
            setFrame(prev => (prev + 1) % SPINNER_FRAMES.length);
        }, speed);
        return () => clearInterval(interval);
    }, [speed]);

    return <Text color={color}>{SPINNER_FRAMES[frame]}</Text>;
}

export default Spinner;
