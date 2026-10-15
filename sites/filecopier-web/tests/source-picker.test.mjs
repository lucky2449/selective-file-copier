import assert from "node:assert/strict";
import { bindSourcePicker } from "../dist/source-picker.mjs";
class Control extends EventTarget {
  value = "previous selection";
  files = [];
}
const primary = new Control(),
  secondary = new Control(),
  input = new Control();
let active = false,
  clicks = 0,
  accepted = [],
  errors = [];
input.click = () => {
  assert.equal(
    active,
    true,
    "Chooser must open within the original user gesture",
  );
  assert.equal(input.value, "", "Reset before opening to allow reselect");
  clicks++;
};
bindSourcePicker({
  buttons: [primary, secondary],
  input,
  onFiles: (files, name) => accepted.push({ files, name }),
  onError: (error) => errors.push(error),
});
function click(button) {
  active = true;
  button.dispatchEvent(new Event("click"));
  active = false;
}
click(primary);
assert.equal(clicks, 1);
click(secondary);
assert.equal(clicks, 2);
const file = {
  name: "photo.jpg",
  webkitRelativePath: "사진 모음/sub/photo.jpg",
};
input.files = [file];
input.dispatchEvent(new Event("change"));
assert.equal(accepted[0].name, "사진 모음");
assert.equal(accepted[0].files[0].path, "사진 모음/sub/photo.jpg");
assert.equal(accepted[0].files[0].file, file);
click(primary);
input.dispatchEvent(new Event("change"));
assert.equal(accepted.length, 2, "Same folder can be selected again");
input.files = [];
input.dispatchEvent(new Event("change"));
assert.equal(accepted.length, 2, "Cancelled selection must preserve source");
input.files = null;
input.dispatchEvent(new Event("change"));
assert.equal(accepted.length, 2);
input.click = () => {
  throw new Error("Blocked chooser");
};
click(primary);
assert.equal(errors.length, 1, "Picker failures must be surfaced");
assert.equal(errors[0].message, "Blocked chooser");
console.log(
  "PASS: primary/secondary chooser, synchronous activation, same-folder reselect, subfolder paths, cancel preservation, error feedback",
);
