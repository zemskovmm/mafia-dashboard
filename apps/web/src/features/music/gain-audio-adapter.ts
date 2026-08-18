interface AudioLike {
  currentTime: number;
  volume: number;
  play(): Promise<void> | void;
  pause(): void;
}

interface GainValue {
  value: number;
}

export class GainAudioAdapter {
  public constructor(
    private readonly audio: AudioLike,
    private readonly gain?: GainValue,
  ) {}

  public play(): Promise<void> | void {
    return this.audio.play();
  }

  public pause(): void {
    this.audio.pause();
  }

  public setVolume(volume: number): void {
    const normalized = Math.min(1, Math.max(0, volume > 1 ? volume / 100 : volume));
    if (this.gain === undefined) this.audio.volume = normalized;
    else this.gain.value = normalized;
  }

  public getVolume(): number {
    return (this.gain?.value ?? this.audio.volume) * 100;
  }

  public seek(seconds: number): void {
    this.audio.currentTime = Math.max(0, seconds);
  }
}
