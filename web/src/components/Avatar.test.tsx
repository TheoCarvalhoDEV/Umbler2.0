// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Avatar } from './Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows initials when there is no picture', () => {
    const { container } = render(<Avatar name="Maria da Silva" src={null} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('MS');
  });

  it('shows the picture, falls back to initials when it fails, and retries a new URL', () => {
    const { container, rerender } = render(<Avatar name="Maria" src="/api/contacts/c1/avatar?v=1" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/contacts/c1/avatar?v=1');
    expect(container.textContent).toBe('');

    fireEvent.error(img);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('M');

    rerender(<Avatar name="Maria" src="/api/contacts/c1/avatar?v=2" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/contacts/c1/avatar?v=2');
  });
});
