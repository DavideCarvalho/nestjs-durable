// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelect } from './multi-select';

// No jest-dom in this package (see `OriginFacets.spec.tsx`): matchers like `toBeChecked` are not
// registered and would THROW rather than fail, so every assertion here reads plain DOM.

const OPTIONS = [
  { value: 'etl', count: 12 },
  { value: 'nightly', count: 3 },
];

function open(label = 'filter by tag'): void {
  fireEvent.click(screen.getByLabelText(label));
}

/** An option ROW inside the popover — never the trigger, which shows the same values as chips. */
function optionButton(text: string): HTMLElement {
  const found = screen
    .getAllByRole('option')
    .find((el) => el.textContent?.replace(/\s+/g, ' ').trim().startsWith(text));
  if (!found) throw new Error(`no option ${text}`);
  return found;
}

describe('<MultiSelect>', () => {
  it('offers what the data contains, with the count behind each value', async () => {
    // The reason the control exists: an operator no longer has to already know a tag to filter by
    // one, and the count says whether picking it is worth anything.
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={[]}
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    open();

    expect(optionButton('etl').textContent).toContain('12');
    expect(optionButton('nightly').textContent).toContain('3');
  });

  it('adds to the selection rather than replacing it — the whole point of a multi-select', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={['etl']}
        onChange={onChange}
        options={OPTIONS}
      />,
    );
    open();
    fireEvent.click(optionButton('nightly'));

    expect(onChange).toHaveBeenCalledWith(['etl', 'nightly']);
  });

  it('removes a value that is already selected', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={['etl', 'nightly']}
        onChange={onChange}
        options={OPTIONS}
      />,
    );
    open();
    fireEvent.click(optionButton('etl'));

    expect(onChange).toHaveBeenCalledWith(['nightly']);
  });

  it('takes a value the list does not offer, because the list is deliberately bounded', async () => {
    // The options are a top-N over a bounded scan, so a rare tag can be real and absent. Without
    // this the picker would filter LESS than the text box it replaced.
    const onChange = vi.fn();
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={[]}
        onChange={onChange}
        options={OPTIONS}
      />,
    );
    open();
    fireEvent.change(screen.getByPlaceholderText('search, or type a value…'), {
      target: { value: 'singleton:order-42' },
    });
    fireEvent.click(screen.getByLabelText('use singleton:order-42 as typed'));

    expect(onChange).toHaveBeenCalledWith(['singleton:order-42']);
  });

  it('keeps a selected value listed even when the current scope no longer offers it', async () => {
    // Narrowing by another filter can remove it from the offered set; if it vanished from the
    // popover too, the operator could not clear it there.
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={['gone']}
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    open();

    expect(optionButton('gone').textContent).toContain('0');
  });

  it('filters the offered list as the operator types', async () => {
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={[]}
        onChange={() => {}}
        options={OPTIONS}
      />,
    );
    open();
    fireEvent.change(screen.getByPlaceholderText('search, or type a value…'), {
      target: { value: 'night' },
    });

    expect(screen.getAllByRole('option').map((el) => el.textContent?.trim())).toEqual([
      expect.stringContaining('nightly'),
    ]);
  });

  it('says the values could not be loaded, instead of looking empty', () => {
    // A failed request and "this deployment has nothing to offer" are the same empty list to an
    // operator — the exact silence that let a broken filter wire read as a console with no data.
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={[]}
        onChange={() => {}}
        options={[]}
        failed
      />,
    );
    open();

    expect(screen.getByText(/couldn't load values/)).toBeTruthy();
  });

  it('clears the whole selection in one action', async () => {
    const onChange = vi.fn();
    render(
      <MultiSelect
        label="filter by tag"
        placeholder="filter by tag…"
        value={['etl', 'nightly']}
        onChange={onChange}
        options={OPTIONS}
      />,
    );
    fireEvent.click(screen.getByLabelText('clear filter by tag'));

    expect(onChange).toHaveBeenCalledWith([]);
  });
});
