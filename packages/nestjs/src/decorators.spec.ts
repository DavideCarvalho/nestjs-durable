import { DurableStep, Step, getDurableStepMeta } from './decorators';

// ---------------------------------------------------------------------------
// Back-compat: `@DurableStep` is a deprecated alias of `@Step`. Discovery reads
// the METADATA (not the decorator name), so a method decorated with either form
// must be discovered identically. This spec keeps the alias path covered.
// ---------------------------------------------------------------------------

describe('@DurableStep alias', () => {
  it('is the same reference as @Step', () => {
    expect(DurableStep).toBe(Step);
  });

  it('writes step metadata identically whether decorated via @Step or @DurableStep', () => {
    class ViaStep {
      @Step('payments.charge')
      charge(_input: unknown) {
        return null;
      }
    }

    class ViaAlias {
      @DurableStep('payments.charge')
      charge(_input: unknown) {
        return null;
      }
    }

    const viaStep = getDurableStepMeta(ViaStep.prototype.charge);
    const viaAlias = getDurableStepMeta(ViaAlias.prototype.charge);

    expect(viaStep).toEqual({ name: 'payments.charge' });
    expect(viaAlias).toEqual(viaStep);
  });
});
