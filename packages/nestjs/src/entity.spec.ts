import 'reflect-metadata';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { DurableModule } from './durable.module';
import { Entity, EntityService, On } from './entity';

@Entity({ name: 'cart' })
@Injectable()
class Cart {
  items: string[] = [];
  @On('add') add(item: string) {
    this.items.push(item);
  }
  @On('count') count() {
    return this.items.length;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

describe('@Entity / @On / EntityService', () => {
  it('runs serialized ops per key over durable state (methods survive replay)', async () => {
    const store = new InMemoryStateStore();
    const mod = await Test.createTestingModule({
      imports: [DurableModule.forRoot({ store, timerPollMs: 0 })],
      providers: [Cart],
    }).compile();
    await mod.init();
    const entities = mod.get(EntityService);

    await entities.signal('cart', 'u1', 'add', 'apple');
    await entities.signal('cart', 'u1', 'add', 'pear'); // second op re-attaches the class prototype
    await entities.signal('cart', 'u2', 'add', 'milk');

    const wait = async (key: string, len: number) => {
      for (let i = 0; i < 300; i += 1) {
        const s = await entities.getState<{ items: string[] }>('cart', key);
        if (s?.items.length === len) return;
        await tick();
      }
      throw new Error(`${key} never reached ${len}`);
    };
    await wait('u1', 2);
    await wait('u2', 1);
    expect((await entities.getState<{ items: string[] }>('cart', 'u1'))?.items).toEqual([
      'apple',
      'pear',
    ]);
    expect((await entities.getState<{ items: string[] }>('cart', 'u2'))?.items).toEqual(['milk']);
  });
});
