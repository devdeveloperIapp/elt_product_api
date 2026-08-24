const Connector = require("../model/connectorModel");
const { createConnectorValidation } = require("../validation/connectorValidation");
const { Op } = require('sequelize');

exports.create = async (req, res) => {
    try {
        const { error } = createConnectorValidation.validate(req.body, { abortEarly: false });
        if (error) {
            return res.status(400).json({
                success: false,
                data: null,
                message: error.message
            })
        }
        const data = req.body;
        const connectorExist = await Connector.findOne({ where: { name: data.name } });
        if (connectorExist) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "This Connector is already exist"
            })
        }
        const connector = await Connector.create(data);
        return res.status(200).json({
            success: true,
            data: null,
            message: "Connector created Successfully"
        })

    } catch (error) {
        console.log("error", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong."
        })
    }

}




exports.fetchList = async (req, res) => {
    try {
        const { type } = req.query;

        const where = {};

        if (type === 'source') {
            where.type = { [Op.in]: ['source', 'both'] };
        } else if (type === 'destination') {
            where.type = { [Op.in]: ['destination', 'both'] };
        }
        
        console.log("where", where);
        console.log("type 33", type);

        const connectors = await Connector.findAll({
            where,
            logging: console.log
        });

        return res.status(200).json({
            success: true,
            data: {
                connectors,
                type
            },
            message: "Connectors fetched successfully"
        });

    } catch (error) {
        console.error("error", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: 'Something went wrong',
        });
    }
}

exports.update = async (req, res) => {
    try {
        const { connectorName } = req.params;
        const data = req.body;
        if (!data) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Please specify the data you want to update."
            })
        }
        const [affectedRows] = await Connector.update(data, { where: { name: connectorName } });
        console.log("cone", affectedRows === 0)
        if (affectedRows === 0) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Connector name is not exist."
            })
        }
        return res.status(200).json({
            success: true,
            data: null,
            message: "Connector updated Successfully"
        })

    } catch (error) {
        console.log("error", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong."
        })
    }

}

exports.delete = async (req, res) => {
    try {
        const { connectorName } = req.params;

        if (!connectorName) {
            return res.status(400).json({
                success: false,
                data: null,
                message: "Please specify the connector name you want to delete."
            });
        }

        const deletedRows = await Connector.destroy({ where: { name: connectorName } });

        if (deletedRows === 0) {
            return res.status(404).json({
                success: false,
                data: null,
                message: "Connector name does not exist."
            });
        }

        return res.status(200).json({
            success: true,
            data: null,
            message: "Connector deleted successfully."
        });

    } catch (error) {
        console.error("error", error);
        return res.status(500).json({
            success: false,
            data: null,
            message: "Something went wrong."
        });
    }
};
