const fs = require("fs");
const path = require("path");
const configPath = path.join(__dirname, "./globalData.js");

exports.updateConfig = async (acccess_token) => {
    try {
      const accessToken = acccess_token;
 
      if (!accessToken) {
        // return res
        //   .status(400)
        //   .json({ success: false, message: "Missing accessToken" });
      }
 
      // Create JS module string
      const updatedContent = `module.exports = {\n  accessToken: "${accessToken}"\n};\n`;
 
      // Overwrite file
      fs.writeFileSync(configPath, updatedContent, "utf8");
 
    //   return res.json({
    //     success: true,
    //     message: "accessToken updated in config.js",
    //   });
    } catch (e) {
      console.error("Error writing config.js:", e);

    }
  };
 