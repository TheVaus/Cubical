import { For } from 'solid-js';
import './Menu.css';

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  items: MenuItem[];
}

const Menu = (props: MenuProps) => {
  return (
    <div class="menu" role="menu">
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            class="menu-item"
            classList={{ danger: item.danger }}
            disabled={item.disabled}
            onClick={() => item.onSelect()}
          >
            <span>{item.label}</span>
            {item.shortcut && <span class="menu-shortcut">{item.shortcut}</span>}
          </button>
        )}
      </For>
    </div>
  );
};

export default Menu;
