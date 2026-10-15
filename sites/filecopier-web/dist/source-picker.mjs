// Open synchronously from the click event to retain browser user activation.
// Standard directory inputs also work where showDirectoryPicker is exposed
// but unsupported by the embedded browser host.
export function bindSourcePicker({
  buttons,
  input,
  onFiles,
  onError = () => {},
}) {
  for (const button of buttons) {
    button.addEventListener("click", () => {
      try {
        input.value = ""; // Selecting the same folder must trigger change again.
        input.click();
      } catch (error) {
        onError(error);
      }
    });
  }
  input.addEventListener("change", (event) => {
    try {
      const selected = Array.from(event.target.files ?? []);
      if (!selected.length) return; // Cancellation preserves the previous source.
      const files = selected.map((file) => ({
        name: file.name,
        path: file.webkitRelativePath || file.name,
        file,
      }));
      const name =
        selected[0].webkitRelativePath?.split("/")[0] || "선택한 파일";
      onFiles(files, name);
    } catch (error) {
      onError(error);
    } finally {
      input.value = "";
    }
  });
}
