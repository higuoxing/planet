document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("pre > code").forEach(function (codeBlock) {
    const wrapper = document.createElement("div");
    wrapper.className = "code-block";

    const pre = codeBlock.parentNode;
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const button = document.createElement("button");
    button.className = "copy-btn";
    button.type = "button";
    button.innerText = "Copy";

    button.addEventListener("click", function () {
      navigator.clipboard.writeText(codeBlock.innerText).then(() => {
        button.innerText = "Copied!";
        button.classList.add("copied");
        setTimeout(() => {
          button.innerText = "Copy";
          button.classList.remove("copied");
        }, 1500);
      });
    });

    wrapper.appendChild(button);
  });
});
