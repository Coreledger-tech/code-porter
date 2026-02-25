import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Code Porter API listening on port ${port}`);
});
