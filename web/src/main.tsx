if (location.pathname === "/mini") void import("./mini/MiniApp").then((m) => m.mount());
else void import("./boot");
